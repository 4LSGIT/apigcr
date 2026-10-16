// tests/launcherS4b.test.js
//
/**
 * ui-custom S4b — "Customize my launcher": the user's own Home / sidebar
 * layout editor (public/js/ycLayoutEditor.js), opened from the All tab.
 *
 *   1. THE CORE (ycLayoutEditor.session — pure), run in a bare vm with the
 *      page's REAL ycLauncher block over the real registry, every document it
 *      produces checked by the REAL server validator (lib/uiConfigShape.js):
 *      an edited surface is written as its full visible list; reset deletes
 *      both keys of that surface only; the other surface stays exactly as
 *      stored; a hide goes to removed and out of placed; a locked item can't
 *      be hidden; the picker offers only effective items not already visible;
 *      ineffective placements and removals are carried, never dropped; dirty
 *      tracking is key-order-insensitive. A seeded fuzz runs random edit
 *      sequences: every document validates unchanged, and resolveLayout
 *      renders it back as exactly the list the editor showed — also after a
 *      trip through storage with MySQL's key order.
 *   2. THE PANEL, RUN FOR REAL in jsdom: the page's own launcher mounts, the
 *      All tab's markup and ycAll.js, then ycLayoutEditor.js — the entry
 *      button opens it; clicks edit; Save PUTs the document, refreshes
 *      firmData.ui and re-runs applyAccess (the launcher changes without a
 *      reload); a locked row's hide is disabled; leaving with changes asks;
 *      a 400's errors[] show inside the panel; markup in labels, renames and
 *      firm item labels stays text.
 *
 * Mutation-checked (see the S4b worker report).
 *
 * Run:  npx jest tests/launcherS4b.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const shape = require('../lib/uiConfigShape');
const { rawShellHtml } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const YCALL_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycAll.js'), 'utf8');
const EDITOR_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycLayoutEditor.js'), 'utf8');

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS4b: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const ALL_TAB = slice('  <div id="tabAll" class="tab-main">', '\n  <style>');
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const J = (x) => JSON.parse(JSON.stringify(x));
const SF = ['home', 'sidebar'];

// ── the core, in a bare vm (no document: the module hands out its core) ──
function core() {
  // URL: the firm overlay validates a url item's href with it (a browser global)
  const ctx = vm.createContext({ URL, console: { error: (m) => { throw new Error(String(m)); }, warn() {} } });
  ctx.window = ctx;
  vm.runInContext(ICON_SRC, ctx, { filename: 'ycIcon.js' });
  vm.runInContext(REGISTRY_SRC, ctx, { filename: 'featureRegistry.js' });
  vm.runInContext(RENDERER_SRC, ctx, { filename: 'index.html#ycLauncher' });
  vm.runInContext(EDITOR_SRC, ctx, { filename: 'ycLayoutEditor.js' });
  return { L: ctx.window.ycLauncher, E: ctx.window.ycLayoutEditor, REG: ctx.window.FEATURE_REGISTRY, LAY: J(ctx.window.DEFAULT_LAYOUTS) };
}
const { L: VL, E: VE, REG, LAY } = core();

const FIRM_ITEM = { id: 'firm:payroll', label: 'Pay <img src=x onerror=alert(1)>', icon: 'money-check',
  action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const FIRM_GONE = { id: 'firm:gone', label: 'Gone for now', icon: 'ghost',
  action: { type: 'url', href: 'https://gone.example.com/', present: 'window' } };
const RO = { items: [FIRM_ITEM, FIRM_GONE], hidden: ['firm:gone'], locked: ['bills'], renames: { cases: { label: 'Matters <b>' } } };
const UI = (layout, ro = RO) => ({ firm: { registry_overrides: ro }, user: layout ? { layout } : {} });
const ACCESS = { isAdmin: true, denied: ['moreViews'] };
function effective(ro = RO) {
  const list = VL.computeEffective({ ...ACCESS, ui: UI(null, ro) });
  return { eff: J(list), groups: J(list.groups) };
}
const { eff: EFF, groups: GROUPS } = effective();
const EFF_IDS = EFF.map((e) => e.id);
const sess = (stored, o = {}) => VE.session({ stored, effective: EFF, locked: RO.locked, base: LAY, registry: REG, groups: GROUPS, ...o });
const R = (sf, user) => J(VL.resolveLayout(sf, { base: LAY[sf], user, effective: EFF, locked: RO.locked }));
const key = (r) => (r.kind === 'item' ? r.id : r.kind === 'label' ? '#' + r.text : '|');
const viewKeys = (s, sf) => J(s.view(sf)).map(key);
const entries = (s, sf) => J(s.view(sf)).map((r) => (r.kind === 'item' ? { item: r.id } : r.kind === 'label' ? { label: r.text } : { break: true }));
const valid = (doc) => {
  const r = shape.validate('user', 'layout', J(doc));
  return { ok: r.ok, errors: r.errors, same: r.ok && shape.canonical(r.value) === shape.canonical(J(doc)) };
};
const idx = (s, sf, id) => J(s.view(sf)).findIndex((r) => r.id === id);
// MySQL hands JSON objects back with their keys re-ordered (shorter keys
// first, then by bytes). This is NOT that order: it is its REVERSE (longest
// key first), on purpose. MySQL's own order happens to equal the order the
// editor builds { placed, removed } / { home, sidebar } in, so modelling it
// faithfully would make every key-order assertion here pass vacuously; the
// reversal guarantees the order differs. Don't "correct" it.
function mysqlOrder(v) {
  if (Array.isArray(v)) return v.map(mysqlOrder);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0)).reverse()
      .forEach((k) => { out[k] = mysqlOrder(v[k]); });
    return out;
  }
  return v;
}

// A stored layout with both surfaces edited, an ineffective firm item placed
// on each and an ineffective id removed. `custom` on both is the custom tab
// ui-custom S5e retired: a stale id now, ineffective like firm:gone.
const STORED = {
  placed: {
    home: [{ item: 'comms' }, { item: 'firm:gone' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' },
      { item: 'contacts' }, { item: 'appts' }, { item: 'bills' }, { item: 'pipeline' }, { item: 'events' },
      { item: 'tasks' }, { item: 'newClient' }, { item: 'custom' }, { item: 'moreFeatures' }],
    sidebar: [{ label: 'Mine' }, { item: 'tasks' }, { item: 'firm:payroll' }, { label: 'Records' }, { item: 'cases' },
      { item: 'firm:gone' }, { item: 'contacts' }, { item: 'appts' }, { item: 'calendar' }, { item: 'events' },
      { item: 'comms' }, { item: 'bills' }, { label: 'Actions' }, { item: 'pipeline' }, { item: 'newClient' },
      { item: 'custom' }, { label: 'Settings' }, { item: 'admin' }, { item: 'moreFeatures' }, { item: 'helpSupport' }],
  },
  removed: { home: ['log', 'moreViews'], sidebar: ['log'] },
};

// ─────────────────────────────────────────────────────────────────────────
describe('the editor core (pure, real resolver, real validator)', () => {
  test('fixtures are what they claim: effective excludes the denied and the firm-hidden; the stored doc is valid', () => {
    expect(EFF_IDS).toEqual(expect.arrayContaining(['firm:payroll', 'cases', 'bills', 'moreAutomations']));
    expect(EFF_IDS).not.toContain('moreViews');
    expect(EFF_IDS).not.toContain('firm:gone');
    expect(valid(STORED)).toEqual({ ok: true, errors: [], same: true });
  });

  test('opened and left alone: the doc is the stored one, not dirty — with nothing stored, too', () => {
    for (const stored of [STORED, null, { placed: {}, removed: {} }]) {
      const s = sess(stored);
      expect(s.isDirty()).toBe(false);
      expect(J(s.doc())).toEqual(stored || { placed: {}, removed: {} });
      for (const sf of SF) expect(s.view(sf).map(key)).toEqual(R(sf, stored || {}).map(key));
    }
  });

  test('dirty tracking is key-order-insensitive: the stored doc in MySQL key order is clean', () => {
    const reordered = mysqlOrder(STORED);
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(STORED));
    expect(JSON.stringify(reordered).indexOf('"removed"')).toBeLessThan(JSON.stringify(reordered).indexOf('"placed"'));
    const s = sess(reordered);
    expect(s.isDirty()).toBe(false);
    expect(s.move('home', 0, 1)).toBe(true);
    expect(s.isDirty()).toBe(true);
    expect(s.move('home', 1, -1)).toBe(true);     // moved back: clean again
    expect(s.isDirty()).toBe(false);
    expect(VE.canonical(reordered)).toBe(VE.canonical(STORED));
  });

  test('an edited surface is written as its FULL visible list (+ the hide in removed); the other surface is not written', () => {
    const s = sess(null);
    expect(s.hide('sidebar', idx(s, 'sidebar', 'events'))).toBe(true);
    const doc = J(s.doc());
    expect(doc.placed.sidebar).toEqual(entries(s, 'sidebar'));
    expect(doc.placed.sidebar.find((e) => e.label === 'Records')).toBeTruthy();   // the base labels come along
    expect(doc.removed).toEqual({ sidebar: ['events'] });
    expect(doc.placed.home).toBeUndefined();
    expect(valid(doc).same).toBe(true);
    expect(R('sidebar', doc).map(key)).toEqual(viewKeys(s, 'sidebar'));
    expect(R('sidebar', doc).map(key)).not.toContain('events');
    expect(R('home', doc).map(key)).toEqual(R('home', {}).map(key));             // Home: still the default
  });

  test('hide goes to removed and out of placed; a locked item cannot be hidden (and says so)', () => {
    const s = sess(null);
    const i = idx(s, 'home', 'log');
    expect(J(s.view('home'))[i]).toMatchObject({ act: 'hide', base: true, locked: false });
    expect(s.hide('home', i)).toBe(true);
    const doc = J(s.doc());
    expect(doc.removed.home).toEqual(['log']);
    expect(doc.placed.home.some((e) => e.item === 'log')).toBe(false);
    expect(s.hidden('home').map((h) => h.id)).toEqual(['log']);
    const b = idx(s, 'home', 'bills');
    expect(J(s.view('home'))[b]).toMatchObject({ act: 'locked', locked: true, label: 'Billing' });
    const before = VE.canonical(s.doc());
    expect(s.hide('home', b)).toBe(false);
    expect(s.remove('home', b)).toBe(false);
    expect(VE.canonical(s.doc())).toBe(before);
    expect(viewKeys(s, 'home')).toContain('bills');
  });

  test('remove: an added item, a break and a label go from placed only; a default item is hidden, never "removed"', () => {
    const s = sess(null);
    expect(s.add('home', 'moreAutomations')).toBe(true);
    expect(s.addBreak()).toBe(true);
    expect(s.addLabel('  Mine  ')).toBe(true);
    const home = J(s.view('home'));
    expect(home[home.length - 2]).toMatchObject({ kind: 'item', id: 'moreAutomations', act: 'remove', base: false });
    expect(home[home.length - 1]).toMatchObject({ kind: 'break', act: 'remove' });
    expect(J(s.view('sidebar')).pop()).toEqual({ kind: 'label', text: 'Mine', act: 'remove' });
    expect(s.remove('home', idx(s, 'home', 'cases'))).toBe(false);
    expect(s.remove('home', home.length - 1)).toBe(true);
    expect(s.remove('home', idx(s, 'home', 'moreAutomations'))).toBe(true);
    expect(J(s.doc()).removed.home).toBeUndefined();
    expect(s.mode('home')).toBe('stored');           // Home is back to what it was
    expect(J(s.doc()).placed.home).toBeUndefined();
    expect(s.isDirty()).toBe(true);                  // the sidebar's label is still new
    expect(s.remove('sidebar', s.view('sidebar').length - 1)).toBe(true);
    expect(s.isDirty()).toBe(false);
  });

  test('reset deletes BOTH keys of that surface only; the other surface is written exactly as stored', () => {
    const s = sess(mysqlOrder(STORED));
    expect(s.reset('home')).toBe(true);
    const doc = J(s.doc());
    expect(doc.placed.home).toBeUndefined();
    expect(doc.removed.home).toBeUndefined();
    expect(doc.placed.sidebar).toEqual(STORED.placed.sidebar);
    expect(doc.removed.sidebar).toEqual(STORED.removed.sidebar);
    expect(s.view('home').map(key)).toEqual(R('home', {}).map(key));
    expect(s.hidden('home')).toEqual([]);
    expect(valid(doc).same).toBe(true);
    // reset a surface with nothing stored: no change at all
    const n = sess({ placed: { home: STORED.placed.home } });
    expect(n.reset('sidebar')).toBe(true);
    expect(n.isDirty()).toBe(false);
  });

  test('editing one surface leaves the other byte-for-byte as stored — ineffective ids and all', () => {
    const s = sess(STORED);
    expect(s.move('sidebar', 2, 1)).toBe(true);
    const doc = J(s.doc());
    expect(doc.placed.home).toEqual(STORED.placed.home);              // firm:gone still there
    expect(doc.removed.home).toEqual(STORED.removed.home);            // moreViews (denied) still there
    expect(doc.placed.sidebar).not.toEqual(STORED.placed.sidebar);
  });

  test('carried, never dropped: an edit keeps an ineffective placed item after the visible item it followed, and ineffective removals', () => {
    const s = sess(STORED);
    expect(s.move('home', 0, 1)).toBe(true);                         // cases, comms, …
    const home = J(s.doc()).placed.home;
    expect(home.map((e) => e.item || '|').slice(0, 3)).toEqual(['cases', 'comms', 'firm:gone']);
    expect(J(s.doc()).removed.home).toEqual(['log', 'moreViews']);
    // it follows its anchor when the anchor moves …
    const m = sess(STORED);
    expect(m.move('sidebar', idx(m, 'sidebar', 'cases'), -1)).toBe(true);    // cases above #Records
    const ms = J(m.doc()).placed.sidebar.map((e) => e.item || '#' + e.label);
    expect(ms.slice(2, 6)).toEqual(['firm:payroll', 'cases', 'firm:gone', '#Records']);
    // … and with the anchor hidden, it goes after the nearest earlier visible item still held
    const t = sess(STORED);
    expect(t.hide('sidebar', idx(t, 'sidebar', 'cases'))).toBe(true);
    const sb = J(t.doc()).placed.sidebar.map((e) => e.item || '#' + e.label);
    expect(sb.indexOf('firm:gone')).toBe(sb.indexOf('firm:payroll') + 1);
    expect(sb.filter((x) => x === 'firm:gone')).toHaveLength(1);
    // when the firm un-hides it, it is back where the user had it
    const back = effective({ ...RO, hidden: [] }).eff;
    const out = J(VL.resolveLayout('home', { base: LAY.home, user: J(s.doc()), effective: back, locked: RO.locked })).map(key);
    expect(out.slice(0, 3)).toEqual(['cases', 'comms', 'firm:gone']);
    // a reset drops them with the rest — that is what a reset is
    t.reset('sidebar');
    expect(J(t.doc()).placed.sidebar).toBeUndefined();
  });

  test('show puts a hidden default back in its base slot (by the resolver); add from the picker un-hides too', () => {
    const s = sess(null);
    expect(s.move('home', 0, 1)).toBe(true);                        // a placed list now
    expect(s.hide('home', idx(s, 'home', 'pipeline'))).toBe(true);
    expect(s.hidden('home').map((h) => h.id)).toEqual(['pipeline']);
    expect(s.show('home', 'pipeline')).toBe(true);
    const keys = viewKeys(s, 'home');
    expect(keys.indexOf('pipeline')).toBe(keys.indexOf('bills') + 1);
    expect(J(s.doc()).removed.home).toBeUndefined();
    expect(s.show('home', 'pipeline')).toBe(false);                  // not hidden any more
    expect(s.hide('home', idx(s, 'home', 'tasks'))).toBe(true);
    expect(s.candidates('home').flatMap((g) => g.items.map((i) => i.id))).toContain('tasks');
    expect(s.add('home', 'tasks')).toBe(true);
    expect(viewKeys(s, 'home').pop()).toBe('tasks');
    expect(s.hidden('home')).toEqual([]);
    expect(J(s.doc()).removed.home).toBeUndefined();
  });

  test('the picker: effective items not visible on that surface, grouped like All; a query ranks with the All matcher', () => {
    const s = sess(STORED);
    for (const sf of SF) {
      const vis = new Set(viewKeys(s, sf));
      const groups = J(s.candidates(sf));
      const ids = groups.flatMap((g) => g.items.map((i) => i.id));
      expect(ids.filter((id) => vis.has(id))).toEqual([]);
      expect(ids.filter((id) => !EFF_IDS.includes(id))).toEqual([]);
      expect(ids.sort()).toEqual(EFF_IDS.filter((id) => !vis.has(id)).sort());
      expect(ids).not.toContain('moreViews');                       // denied
      expect(ids).not.toContain('firm:gone');                       // firm-hidden
      const order = groups.map((g) => g.group);
      expect(order).toEqual(GROUPS.filter((g) => order.includes(g)));
    }
    expect(J(s.candidates('home')).flatMap((g) => g.items.map((i) => i.id))).toContain('log');      // hidden here: offered
    expect(J(s.candidates('home')).flatMap((g) => g.items.map((i) => i.id))).toContain('firm:payroll');
    const hits = J(s.candidates('home', 'fb'));
    expect(hits).toHaveLength(1);
    expect(hits[0].group).toBe(null);
    expect(hits[0].items[0].id).toBe('moreFormBuilder');
    expect(s.add('home', 'cases')).toBe(false);                       // already visible
    expect(s.add('home', 'moreViews')).toBe(false);                   // not effective
    expect(s.add('home', 'firm:gone')).toBe(false);
  });

  test('labels: the server\'s rule (plain text, trimmed, 1–40); a bad one is refused, nothing changes', () => {
    const s = sess(null);
    for (const bad of ['', '   ', 'x'.repeat(41), 'a\u0007b', 'a b', 5]) {
      expect(VE.labelProblem(bad)).toEqual(expect.any(String));
      expect(s.addLabel(bad)).toBe(false);
    }
    expect(s.isDirty()).toBe(false);
    expect(VE.labelProblem('x'.repeat(40))).toBe(null);
    expect(s.addLabel('<b>Mine</b>')).toBe(true);
    const i = s.view('sidebar').length - 1;
    expect(s.setLabel('sidebar', i, '')).toBe(false);
    expect(s.setLabel('sidebar', i, ' Renamed ')).toBe(true);
    expect(J(s.view('sidebar'))[i]).toEqual({ kind: 'label', text: 'Renamed', act: 'remove' });
    expect(s.setLabel('sidebar', 1, 'x')).toBe(false);                 // not a label row
    expect(valid(s.doc()).same).toBe(true);
  });

  test('caps: a surface holds at most 100 entries; adds stop there', () => {
    const s = sess(null);
    let n = 0;
    while (s.addBreak()) if (++n > 200) break;
    expect(s.room('home')).toBe(0);
    expect(J(s.doc()).placed.home).toHaveLength(100);
    expect(s.add('home', 'moreAutomations')).toBe(false);
    expect(valid(s.doc()).ok).toBe(true);
  });

  test('fuzz: random edit sequences always yield a valid doc that resolveLayout renders back as the list shown — through storage too', () => {
    let seed = 20261016;   // mulberry32: deterministic, and its low bits don't correlate call to call
    const rnd = (n) => {
      seed = (seed + 0x6D2B79F5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const starts = [null, STORED, mysqlOrder(STORED), { placed: { sidebar: [{ item: 'log' }] }, removed: { home: ['tasks', 'firm:gone'] } }];
    let docs = 0;
    const tally = { editedHome: 0, editedSidebar: 0, reset: 0, removed: 0, label: 0, break: 0, carried: 0, added: 0 };
    for (let run = 0; run < 160; run++) {
      const s = sess(starts[run % starts.length]);
      for (let step = 0; step < 25; step++) {
        const sf = SF[rnd(2)], view = J(s.view(sf)), i = rnd(Math.max(1, view.length));
        switch (rnd(10)) {
          case 0: case 1: s.move(sf, i, rnd(2) ? 1 : -1); break;
          case 2: s.hide(sf, i); break;
          case 3: s.remove(sf, i); break;
          case 4: { const h = s.hidden(sf); if (h.length) s.show(sf, h[rnd(h.length)].id); break; }
          case 5: { const c = J(s.candidates(sf)).flatMap((g) => g.items); if (c.length) s.add(sf, c[rnd(c.length)].id); break; }
          case 6: if (sf === 'home') s.addBreak(); else s.addLabel(['A', ' b ', 'Long label ' + 'x'.repeat(29), '', '<i>x</i>'][rnd(5)]); break;
          case 7: if (rnd(3) === 0) { s.reset(sf); tally.reset++; } break;
          case 8: { const lab = view.findIndex((r) => r.kind === 'label'); if (lab >= 0) s.setLabel(sf, lab, ['Z', '', 'Q q'][rnd(3)]); break; }
          default: s.move(sf, i, -1);
        }
        const doc = J(s.doc());
        const v = valid(doc);
        if (!v.same) throw new Error(`run ${run} step ${step}: ${JSON.stringify(v.errors)} ${JSON.stringify(doc)}`);
        for (const x of SF) {
          if (R(x, doc).map(key).join(',') !== viewKeys(s, x).join(',')) throw new Error(`run ${run} step ${step}: ${x} round-trip differs`);
        }
        docs++;
        tally.editedHome += s.mode('home') === 'edited';
        tally.editedSidebar += s.mode('sidebar') === 'edited';
        tally.removed += !!(doc.removed.home || doc.removed.sidebar);
        tally.label += (doc.placed.sidebar || []).some((e) => e.label && !['Records', 'Actions', 'Settings', 'Mine'].includes(e.label));
        tally.break += (doc.placed.home || []).filter((e) => e.break).length > 3;
        tally.carried += s.mode('sidebar') === 'edited' && (doc.placed.sidebar || []).some((e) => e.item === 'firm:gone');
        tally.added += (doc.placed.home || []).some((e) => e.item && !LAY.home.some((b) => b.item === e.item));
      }
      // stored the way MySQL hands it back, reopened: clean, and the same lists
      const again = sess(mysqlOrder(J(s.doc())));
      expect(again.isDirty()).toBe(false);
      for (const x of SF) expect(viewKeys(again, x)).toEqual(viewKeys(s, x));
    }
    expect(docs).toBe(160 * 25);
    // the sequences really reach every kind of edit (not a vacuous pass)
    for (const [k, n] of Object.entries(tally)) expect([k, n > 20]).toEqual([k, true]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The panel, for real: the page's launcher mounts + All tab + ycAll.js +
// ycLayoutEditor.js, with an in-memory PUT that validates with the real
// validator.
// layout: the shell's login-time copy (firmData.ui.user.layout); serverLayout:
// what the server holds now (GET /api/ui-config) — the same unless a test says.
function boot({ layout = null, ro = RO, access = ACCESS, serverLayout = layout, serverRo = ro } = {}) {
  const LAYD = LAY;
  const placedIds = (sf) => LAYD[sf].filter((e) => e.item).map((e) => e.item);
  const grid = (sf) => placedIds(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabAll'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    ${ALL_TAB}
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script></div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script></div>
    <div id="ycPanels" style="display:none">${grid('more')}${grid('admin')}</div>
  </body></html>`;
  const errors = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window;
  w.console.error = (...a) => errors.push(a.join(' '));
  w.console.warn = (...a) => errors.push(a.join(' '));
  const stubs = new Set();
  let stubSrc = 'var E = (id) => document.getElementById(id);\nfunction syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(REG)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + DRILL_SRC);
  // the shell's copy of the layers, then login's applyAccess
  w.firmData = { ui: J(UI(layout, ro)) };
  w.ycLauncher.applyAccess({ ...access, ui: w.firmData.ui });
  // the server: GET /api/ui-config answers the layers it holds (failGet: a
  // rejection); PUT validates with the real validator; `fail` forces a reply;
  // `hold` keeps a PUT pending until server.release() is called
  const server = { puts: [], gets: 0, fail: null, failGet: null, hold: false, release: null, stored: serverLayout, firm: J(UI(null, serverRo).firm) };
  w.apiSend = (url, method, body) => {
    if (method === 'GET' || method == null) {
      server.gets++;
      if (url !== '/api/ui-config') return Promise.reject(new Error('unexpected GET ' + url));
      if (server.failGet) return Promise.reject(Object.assign(new Error(server.failGet.message || 'down'), server.failGet));
      return Promise.resolve(mysqlOrder({ status: 'success', firm: J(server.firm), user: server.stored ? { layout: J(server.stored) } : {}, can_edit_firm: false }));
    }
    server.puts.push(J({ url, method, body }));
    if (server.hold) return new Promise((resolve) => { server.release = () => { server.hold = false; resolve(answerPut(body)); }; });
    return answerPut(body);
  };
  function answerPut(body) {
    if (server.fail) return Promise.reject(Object.assign(new Error(server.fail.message || 'refused'), server.fail));
    const v = shape.validateWrite(J(body));
    if (!v.ok) return Promise.reject(Object.assign(new Error('Invalid'), { status: 400, body: { status: 'error', errors: v.errors } }));
    server.stored = mysqlOrder(v.value.config);
    return Promise.resolve({ status: 'success', scope: 'user', config_key: 'layout', config: J(server.stored), changed: true, versioned: false });
  }
  const confirms = [];
  let answer = true;
  w.confirm = (text) => { confirms.push(text); return answer; };
  w.eval(YCALL_SRC);
  w.eval(EDITOR_SRC);
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);
  const $$ = (sel) => [...d.querySelectorAll(sel)];
  const panel = () => d.getElementById('ycLayoutEditor');
  const sec = (sf) => panel().querySelector(`.yle-sec[data-sf="${sf}"]`);
  const rows = (sf) => [...sec(sf).querySelectorAll('.yle-rows > .yle-row')];
  const rowNames = (sf) => rows(sf).map((li) => {
    const inp = li.querySelector('.yle-label-in');
    return inp ? '#' + inp.value : li.classList.contains('yle-row-break') ? '|' : li.querySelector('.yle-name').textContent;
  });
  const rowOf = (sf, name) => rows(sf).find((li) => (li.querySelector('.yle-name') || {}).textContent === name);
  const act = (sf, name, a) => rowOf(sf, name).querySelector(`[data-act="${a}"]`);
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const homeGrid = d.querySelector('#tabHome > .home-grid');
  const elOf = (el, sf) => {
    if (el.hasAttribute('data-yc-shortcut')) return '+' + el.getAttribute('data-yc-shortcut');
    for (const id of Object.keys(REG)) if (w.ycLauncher.elementsOf(id)[sf] === el) return id;
    return '?';
  };
  const sbNodes = () => {
    const out = [];
    for (let n = d.getElementById('tabOpenFiles').nextElementSibling; n; n = n.nextElementSibling) out.push(n);
    return out;
  };
  const seen = (sf) => (sf === 'home' ? [...homeGrid.children] : sbNodes())
    .filter((el) => shown(el))
    .map((el) => (el.classList.contains('home-break') ? '|' : el.classList.contains('sb-section-label') ? '#' + el.textContent : elOf(el, sf)));
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // the All button, then the editor's read of the current layers
  const open = async () => { d.getElementById('ycAllCustomize').click(); await flush(); };
  return {
    open, w, d, $, $$, panel, sec, rows, rowNames, rowOf, act, seen, server, confirms, errors, flush,
    answer: (v) => { answer = v; }, close: () => w.close(),
  };
}

describe('the panel (for real, jsdom)', () => {
  let t;
  afterEach(() => t && t.close());

  test('"Customize my launcher" sits in the All tab and opens the editor; the rows are the resolved layout', async () => {
    t = boot({ layout: STORED });
    const b = t.d.getElementById('ycAllCustomize');
    expect(b.closest('#tabAll')).toBeTruthy();
    expect(b.textContent).toBe('Customize my launcher');
    expect(b.hasAttribute('data-target') || b.hasAttribute('data-exclusive-group')).toBe(false);
    expect(t.panel()).toBe(null);                       // built on first open
    await t.open();
    expect(t.server.gets).toBe(1);                      // it read the current layers first
    expect(t.panel().hidden).toBe(false);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
    const box = t.panel().querySelector('.yle-box');
    expect([box.getAttribute('role'), box.getAttribute('aria-modal')]).toEqual(['dialog', 'true']);
    const want = (sf) => J(t.w.ycLauncher.resolveLayout(sf, { base: LAY[sf], user: STORED, effective: t.w.ycLauncher.effectiveRegistry(), locked: RO.locked }))
      .map((r) => (r.kind === 'break' ? '|' : r.kind === 'label' ? '#' + r.text : t.w.ycLauncher.effectiveRegistry().find((e) => e.id === r.id).label));
    expect(t.rowNames('sidebar')).toEqual(want('sidebar'));
    expect(t.rowNames('home')).toEqual(want('home').map((x) => (x === 'Bills' ? 'Billing' : x)));
    expect(t.rowNames('home')).toContain('Matters <b>');                         // the firm rename applies
    expect([...t.sec('home').querySelectorAll('.yle-hidden-row .yle-name')].map((n) => n.textContent)).toEqual(['Log']);
    expect(t.errors).toEqual([]);
  });

  test('before login it does nothing', async () => {
    t = boot();
    const fresh = new JSDOM('<!DOCTYPE html><body><div id="tabAll"><button id="ycAllCustomize"></button></div></body>', { runScripts: 'dangerously' });
    fresh.window.eval(ICON_SRC + REGISTRY_SRC + RENDERER_SRC + EDITOR_SRC);
    expect(await fresh.window.ycLayoutEditor.open()).toBe(false);
    fresh.window.document.getElementById('ycAllCustomize').click();
    expect(fresh.window.document.getElementById('ycLayoutEditor')).toBe(null);
    fresh.window.close();
  });

  test('reorder Home, hide a sidebar item, pin a More panel, add a break and a label → Save PUTs it and the launcher follows, no reload', async () => {
    t = boot();
    const marker = t.w.__noReload = {};
    await t.open();
    const status = () => t.panel().querySelector('.yle-status').textContent;
    const save = t.panel().querySelector('.yle-save');
    expect([status(), save.disabled]).toEqual(['No changes', true]);
    t.act('home', 'Contacts', 'up').click();                                   // reorder Home
    expect(t.rowNames('home').slice(0, 2)).toEqual(['Contacts', 'Matters <b>']);
    expect(t.d.activeElement).toBe(t.act('home', 'Contacts', 'down'));         // focus follows the row (up is disabled at the top)
    t.act('home', 'Appointments', 'up').click();
    expect(t.d.activeElement).toBe(t.act('home', 'Appointments', 'up'));
    t.act('home', 'Appointments', 'down').click();
    t.act('sidebar', 'Events', 'hide').click();                                // hide a sidebar item
    expect(t.rowNames('sidebar')).not.toContain('Events');
    expect([...t.sec('sidebar').querySelectorAll('.yle-hidden-row .yle-name')].map((n) => n.textContent)).toEqual(['Events']);
    t.sec('home').querySelector('[data-act="pick"]').click();                  // pin a More panel to Home
    const q = t.sec('home').querySelector('.yle-pick-q');
    q.value = 'documents';
    q.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    const pick = t.sec('home').querySelector('.yle-pick-item[data-id="moreDocuments"]');
    expect(pick).toBeTruthy();
    pick.click();
    expect(t.rowNames('home').pop()).toBe('Documents');
    t.sec('home').querySelector('[data-act="add-break"]').click();             // a break
    t.sec('sidebar').querySelector('[data-act="label-open"]').click();          // a label
    const li = t.sec('sidebar').querySelector('.yle-new-label');
    li.value = 'QA Label';
    t.sec('sidebar').querySelector('[data-act="label-add"]').click();
    expect(t.rowNames('sidebar').pop()).toBe('#QA Label');
    expect([status(), save.disabled]).toEqual(['Unsaved changes', false]);

    save.click();
    await t.flush();
    expect(t.server.puts).toHaveLength(1);
    const put = t.server.puts[0];
    expect([put.url, put.method, put.body.scope, put.body.config_key]).toEqual(['/api/ui-config', 'PUT', 'user', 'layout']);
    expect(valid(put.body.config).same).toBe(true);
    expect(put.body.config.removed).toEqual({ sidebar: ['events'] });
    expect(t.panel().hidden).toBe(true);                                        // closed
    // firmData holds the STORED document, and the launcher was re-run with it
    expect(t.w.firmData.ui.user.layout).toEqual(J(t.server.stored));
    expect(t.w.firmData.ui.firm).toEqual(J(UI(null).firm));
    expect(t.seen('home').slice(0, 2)).toEqual(['contacts', 'cases']);
    expect(t.seen('home').slice(-2)).toEqual(['+moreDocuments', '|']);
    expect(t.seen('sidebar')).not.toContain('events');
    expect(t.seen('sidebar').pop()).toBe('#QA Label');
    expect(t.w.__noReload).toBe(marker);

    // reopen: the editor starts from what was saved; Reset Home keeps the sidebar's edit
    await t.open();
    expect(t.rowNames('home').slice(0, 2)).toEqual(['Contacts', 'Matters <b>']);
    t.sec('home').querySelector('[data-act="reset"]').click();
    await t.flush();
    expect(t.confirms.pop()).toMatch(/Reset Home/);
    expect(t.rowNames('home')[0]).toBe('Matters <b>');
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    const doc2 = t.server.puts[1].body.config;
    expect(doc2.placed.home).toBeUndefined();
    expect(doc2.removed.home).toBeUndefined();
    expect(doc2.placed.sidebar).toEqual(put.body.config.placed.sidebar);
    expect(doc2.removed.sidebar).toEqual(['events']);
    expect(t.seen('home').slice(0, 3)).toEqual(['cases', 'contacts', 'appts']);
    expect(t.seen('sidebar')).not.toContain('events');
    expect(t.seen('sidebar').pop()).toBe('#QA Label');
    expect(t.errors).toEqual([]);
  });

  test('a locked item\'s hide control is disabled, with the reason', async () => {
    t = boot();
    await t.open();
    for (const sf of ['home', 'sidebar']) {
      const row = t.rowOf(sf, sf === 'home' ? 'Billing' : 'Bills');
      const h = row.querySelector('[data-act="hide"]');
      expect(h.disabled).toBe(true);
      expect(h.getAttribute('title')).toMatch(/Locked by your firm/);
      expect(row.querySelector('.yle-tag').textContent).toMatch(/Locked/);
      h.disabled = false;                     // even forced, the core refuses
      h.click();
      expect(t.rowNames(sf)).toContain(sf === 'home' ? 'Billing' : 'Bills');
    }
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
  });

  test('leaving with unsaved changes asks first — Cancel, the close button, Esc, the backdrop; declining keeps the edits', async () => {
    t = boot();
    await t.open();
    t.act('home', 'Contacts', 'up').click();
    const ways = [
      () => t.panel().querySelector('.yle-cancel').click(),
      () => t.panel().querySelector('.yle-x').click(),
      () => t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () => { t.panel().dispatchEvent(new t.w.MouseEvent('mousedown', { bubbles: true })); t.panel().click(); },
    ];
    t.answer(false);
    for (const way of ways) {
      way();
      await t.flush();
      expect(t.confirms.pop()).toMatch(/Discard your unsaved launcher changes/);
      expect(t.panel().hidden).toBe(false);
      expect(t.rowNames('home')[0]).toBe('Contacts');
    }
    // a reload while dirty is held
    const ev = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    t.answer(true);
    t.panel().querySelector('.yle-cancel').click();
    await t.flush();
    expect(t.panel().hidden).toBe(true);
    expect(t.server.puts).toHaveLength(0);
    expect(t.w.firmData.ui.user.layout).toBeUndefined();
    const ev2 = new t.w.Event('beforeunload', { cancelable: true });
    t.w.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
    // clean: closes without asking; reopening shows the stored state again
    t.confirms.length = 0;
    await t.open();
    expect(t.rowNames('home')[0]).toBe('Matters <b>');
    t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await t.flush();
    expect(t.confirms).toHaveLength(0);
    expect(t.panel().hidden).toBe(true);
  });

  test('a server 400 shows its errors[] inside the panel — per surface where the path names one — and keeps the edits', async () => {
    t = boot();
    await t.open();
    t.act('home', 'Contacts', 'up').click();
    t.server.fail = { status: 400, message: 'Invalid ui config', body: { status: 'error', errors: ['placed.home[3]: unknown field "<img src=x onerror=alert(1)>"', 'removed.sidebar: at most 100 entries', 'something general <img src=x>'] } };
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.panel().hidden).toBe(false);
    const errs = (sf) => [...t.sec(sf).querySelectorAll('.yle-errs li')].map((l) => l.textContent);
    expect(errs('home')).toEqual(['placed.home[3]: unknown field "<img src=x onerror=alert(1)>"']);   // the server echoes client text: it stays text
    expect(errs('sidebar')).toEqual(['removed.sidebar: at most 100 entries']);
    const banner = t.panel().querySelector('.yle-banner');
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toMatch(/refused.*something general <img src=x>/);
    expect(t.panel().querySelector('.yle-banner img, .yle-errs img')).toBe(null);
    expect(t.rowNames('home')[0]).toBe('Contacts');
    expect(t.w.firmData.ui.user.layout).toBeUndefined();
    // a non-400 failure: a plain message, edits kept
    t.server.fail = { status: 500, message: 'UI config request failed' };
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(banner.textContent).toMatch(/Save failed: UI config request failed/);
    // and the next good save clears the messages
    t.server.fail = null;
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.panel().hidden).toBe(true);
    await t.open();
    expect(banner.hidden).toBe(true);
    expect(errs('home')).toEqual([]);
  });

  test('a bad section label is held in its box with the message and blocks Save', async () => {
    t = boot({ layout: STORED });
    await t.open();
    const inp = t.sec('sidebar').querySelector('.yle-label-in');
    expect(inp.value).toBe('Mine');
    inp.value = '';
    inp.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    expect(inp.getAttribute('aria-invalid')).toBe('true');
    expect(inp.parentNode.querySelector('.yle-field-err').textContent).toBe('Type a label');
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts).toHaveLength(0);
    expect(t.panel().querySelector('.yle-banner').textContent).toMatch(/Fix the highlighted section label/);
    inp.value = 'Mine, renamed';
    inp.dispatchEvent(new t.w.Event('input', { bubbles: true }));
    expect(t.panel().querySelector('.yle-save').disabled).toBe(false);
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts[0].body.config.placed.sidebar[0]).toEqual({ label: 'Mine, renamed' });
    expect(t.server.puts[0].body.config.placed.home).toEqual(STORED.placed.home);   // untouched surface as stored
    // the new-label box refuses a bad one inline
    await t.open();
    t.sec('sidebar').querySelector('[data-act="label-open"]').click();
    t.sec('sidebar').querySelector('.yle-new-label').value = 'y'.repeat(41);
    t.sec('sidebar').querySelector('[data-act="label-add"]').click();
    expect(t.sec('sidebar').querySelector('.yle-label-add .yle-field-err').textContent).toBe('At most 40 characters');
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
  });

  test('escaping: markup in user labels, firm renames and firm item labels stays text — rows, hidden list, picker, launcher', async () => {
    const layout = { placed: { sidebar: [{ label: '<img src=x onerror=alert(1)>' }, { item: 'firm:payroll' }, { item: 'cases' }] }, removed: { home: ['log'] } };
    t = boot({ layout });
    await t.open();
    t.sec('home').querySelector('[data-act="pick"]').click();
    expect(t.rowNames('sidebar').slice(0, 3)).toEqual(['#<img src=x onerror=alert(1)>', FIRM_ITEM.label, 'Matters <b>']);
    const names = [...t.panel().querySelectorAll('.yle-name, .yle-pick-item span')].map((n) => n.textContent);
    expect(names).toEqual(expect.arrayContaining([FIRM_ITEM.label, 'Matters <b>']));
    expect(t.panel().querySelectorAll('img, b')).toHaveLength(0);
    expect(t.d.querySelectorAll('img')).toHaveLength(0);
    // aria-labels are attributes set as values, not markup
    expect(t.act('sidebar', FIRM_ITEM.label, 'up').getAttribute('aria-label')).toBe('Move ' + FIRM_ITEM.label + ' up');
    // every icon class comes from a validated slug — a bad one becomes the question mark
    for (const i of t.panel().querySelectorAll('i')) expect(i.className).toMatch(/^fa-solid fa-[a-z0-9-]+( yle-ic)?$/);
  });

  test('saving with nothing changed closes without a PUT', async () => {
    t = boot({ layout: mysqlOrder(STORED) });
    await t.open();
    expect(t.w.ycLayoutEditor.isDirty()).toBe(false);
    t.act('home', 'Contacts', 'down').click();
    t.act('home', 'Contacts', 'up').click();
    expect(t.panel().querySelector('.yle-save').disabled).toBe(true);
    t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await t.flush();
    expect(t.confirms).toHaveLength(0);
    expect(t.server.puts).toHaveLength(0);
  });
});

describe('fix round: the editor reads the current layers; the palette stands down; no edits while saving', () => {
  let t;
  afterEach(() => t && t.close());
  const HOME_ELSEWHERE = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' }] }, removed: { home: ['log'] } };
  const ctrlK = () => { const e = new t.w.KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }); t.d.dispatchEvent(e); return e; };
  const paletteOpen = () => { const p = t.d.getElementById('ycPalette'); return !!(p && !p.hidden); };

  test('SF1: a stale tab opens on the SERVER\'s layout, refreshes the shell to it, and its save keeps the untouched surface', async () => {
    t = boot({ layout: null, serverLayout: HOME_ELSEWHERE });   // another tab saved Home since this one logged in
    expect(t.seen('home').slice(0, 3)).toEqual(['cases', 'contacts', 'appts']);
    await t.open();
    expect(t.server.gets).toBe(1);
    expect(VE.canonical(t.w.firmData.ui.user.layout)).toBe(VE.canonical(HOME_ELSEWHERE));
    expect(t.seen('home').slice(0, 2)).toEqual(['comms', 'cases']);                    // the launcher was re-run with it
    expect(t.rowNames('home').slice(0, 3)).toEqual(['Comms', 'Matters <b>', 'Contacts']);   // contacts slots in after its base neighbour
    t.act('sidebar', 'Events', 'hide').click();                                         // edit the OTHER surface only
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    const doc = t.server.puts[0].body.config;
    expect(doc.placed.home).toEqual(HOME_ELSEWHERE.placed.home);                        // kept, not wiped
    expect(doc.removed).toEqual({ home: ['log'], sidebar: ['events'] });
    expect(t.seen('home').slice(0, 2)).toEqual(['comms', 'cases']);
  });

  test('SF1: after a login whose ui read failed soft ({ firm: {}, user: {} }), the editor takes the firm layer and the layout from the server', async () => {
    t = boot({ layout: null, ro: {}, serverRo: RO, serverLayout: HOME_ELSEWHERE });
    expect(t.w.firmData.ui.firm).toEqual({ registry_overrides: {} });
    await t.open();
    expect(t.w.firmData.ui.firm).toEqual(J(UI(null, RO).firm));
    const bills = t.rowOf('home', 'Billing');
    expect(bills.querySelector('[data-act="hide"]').disabled).toBe(true);              // the firm's lock is known now
    expect(t.rowNames('home')).toContain('Matters <b>');                               // and its rename
    t.act('sidebar', 'Events', 'hide').click();
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts[0].body.config.placed.home).toEqual(HOME_ELSEWHERE.placed.home);
  });

  test('SF1: unchanged layers → no shell refresh (the launcher is not re-run)', async () => {
    t = boot({ layout: STORED });
    let runs = 0;
    t.w.addEventListener('ycLauncherAccess', () => { runs++; });
    await t.open();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
    expect(runs).toBe(0);
  });

  test('SF1: a failed read opens nothing, says so beside the button, writes nothing; the next try opens', async () => {
    t = boot({ layout: STORED });
    t.server.failGet = { status: 500, message: 'UI config request failed' };
    const b = t.d.getElementById('ycAllCustomize');
    b.click();
    expect([b.disabled, b.getAttribute('aria-busy')]).toEqual([true, 'true']);         // busy while the read is out
    b.click();                                                                          // the disabled button swallows a second click…
    const again = t.w.ycLayoutEditor.open();                                            // …and a programmatic open joins the read in flight
    expect(typeof again.then).toBe('function');
    await t.flush();
    expect(t.server.gets).toBe(1);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(t.panel() && !t.panel().hidden).toBeFalsy();
    const msg = t.d.getElementById('ycAllCustomizeMsg');
    expect(msg.hidden).toBe(false);
    expect(msg.textContent).toBe('Couldn\u2019t load your current layout; try again.');
    expect(msg.getAttribute('role')).toBe('alert');
    expect([b.disabled, b.hasAttribute('aria-busy')]).toEqual([false, false]);
    expect(t.server.puts).toHaveLength(0);
    expect(t.w.firmData.ui.user.layout).toEqual(STORED);                                // the shell's copy untouched
    t.server.failGet = null;
    await t.open();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
    expect(msg.hidden).toBe(true);
  });

  test('SF2: Ctrl-K is ignored while the editor is open, and works again once it closes', async () => {
    t = boot();
    await t.open();
    const e = ctrlK();
    expect(paletteOpen()).toBe(false);
    expect(e.defaultPrevented).toBe(false);                                             // stood down: not even claimed
    t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await t.flush();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    ctrlK();
    expect(paletteOpen()).toBe(true);
  });

  test('N1: while a save is in flight, edits, typing and Cancel are ignored; what was sent is what lands', async () => {
    t = boot({ layout: STORED });
    await t.open();
    t.act('home', 'Contacts', 'up').click();
    t.server.hold = true;
    t.panel().querySelector('.yle-save').click();
    await t.flush();
    expect(t.server.puts).toHaveLength(1);
    const before = t.rowNames('sidebar');
    t.act('sidebar', 'Events', 'hide').click();                                         // ignored
    t.act('home', 'Contacts', 'down').click();                                          // ignored
    t.panel().querySelector('.yle-cancel').click();                                     // ignored
    t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));   // ignored too
    await t.flush();
    expect(t.confirms).toHaveLength(0);
    expect(t.rowNames('sidebar')).toEqual(before);
    const inp = t.sec('sidebar').querySelector('.yle-label-in');
    expect(inp.readOnly).toBe(true);
    expect(t.w.ycLayoutEditor.isOpen()).toBe(true);
    t.server.release();
    await t.flush();
    expect(t.w.ycLayoutEditor.isOpen()).toBe(false);
    expect(t.server.puts[0].body.config.removed.sidebar).toEqual(STORED.removed.sidebar);
    expect(t.seen('sidebar')).toContain('events');
    expect(t.server.puts).toHaveLength(1);
    // the next open takes edits again
    await t.open();
    expect(t.sec('sidebar').querySelector('.yle-label-in').readOnly).toBe(false);
  });
});
