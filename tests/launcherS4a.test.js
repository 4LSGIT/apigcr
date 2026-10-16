// tests/launcherS4a.test.js
//
/**
 * ui-custom S4a — the user layer on Home and the sidebar: the resolver
 * (ycLauncher.resolveLayout), the renderer (the layout pass applyAccess runs)
 * and computeEffective's purity.
 *
 *   1. THE RESOLVER (pure, in a bare vm over the real registry): with no
 *      placed list, the base minus that surface's user removals (removals are
 *      per surface — fix round SF1; locked exempt) minus ids
 *      missing from the effective registry; with one, the user's order, base
 *      items neither placed nor removed slotted in after their nearest
 *      preceding base neighbour (or first) — so an item new to the base
 *      appears for a customized user; an explicit placement beats a removal;
 *      breaks are Home's, labels the sidebar's; junk never throws; the output
 *      depends only on the four inputs.
 *   2. THE RENDERER, RUN FOR REAL in jsdom: the page's own renderer mounts the
 *      surfaces (Home inside its .home-grid), the page's own openMainTab /
 *      updateSidebarActive / drill-in / applyCustomTab run over them —
 *      extracted from public/index.html, not re-typed. An empty layout puts
 *      back the default DOM byte for byte (the markup the S1 helper,
 *      tests/helpers/shellHtml.js, expands the page with); a re-run changes
 *      nothing; moved elements keep their ids, listeners and badges; a
 *      removed item stays in the DOM, hidden by data-yc-unplaced, and exec()
 *      still reaches it; neutral shortcuts carry no id / data-target /
 *      data-exclusive-group and run exec(); denies, firm hides, renames,
 *      locks and the custom tab compose with the layout; highlights land on
 *      moved and neutral items.
 *   3. computeEffective is pure: the group order rides on the list, and a
 *      call from anyone (the Firm tab) leaves groups() and the effective
 *      registry as they were.
 *
 * Mutation-checked (see the S4a worker report).
 *
 * Run:  npx jest tests/launcherS4a.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const RAW = rawShellHtml();
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
// the stored icon value → classes, loaded before the launcher as in index.html (ui-custom S6a)
const ICON_SRC = fs.readFileSync(path.join(ROOT, 'public/js/ycIcon.js'), 'utf8');
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const { launcher: VL, registry: REG, layouts: LAY } = loadLauncher(RAW);

function slice(from, to) {
  const a = RAW.indexOf(from);
  const b = RAW.indexOf(to, a + from.length);
  if (a < 0 || b < 0) throw new Error('launcherS4a: anchor not found: ' + (a < 0 ? from : to));
  return RAW.slice(a, b);
}
const DRILL_SRC = slice('  // ── Big-button hover animations ── HOW TO USE', '</script>\n  <script>\n    params = {};');
const TABS_SRC = slice('    function openMainTab(tabName) {', '    // ---- Global auth state ----');
const CUSTOM_SRC = slice('    function applyCustomTab(cfg) {', '    window.applyCustomTab = applyCustomTab;');
const CURRENT_SRC = slice('    function currentMainTabId() {', '\n    }\n') + '\n    }\n';
const HIDE_CSS = RAW.match(/<style>\[data-yc-denied\][^<]*<\/style>/)[0];

const placed = (sf) => LAY[sf].filter((e) => e.item).map((e) => e.item);
const ALL = [...new Set(['sidebar', 'home', 'more', 'admin'].flatMap(placed))];
const R = (surface, o) => VL.resolveLayout(surface, { base: LAY[surface], effective: ALL, ...o });
const items = (out) => out.filter((e) => e.kind === 'item').map((e) => e.id);
const shape = (out) => out.map((e) => (e.kind === 'item' ? e.id : e.kind === 'label' ? '#' + e.text : '|'));

// ─────────────────────────────────────────────────────────────────────────
describe('resolveLayout (pure)', () => {
  test('no user layout: the base layout, in order, every entry "default"', () => {
    for (const sf of ['home', 'sidebar']) {
      const out = R(sf, {});
      expect(shape(out)).toEqual(LAY[sf].map((e) => (e.item ? e.item : e.label != null ? '#' + e.label : '|')));
      expect(new Set(out.map((e) => e.origin))).toEqual(new Set(['default']));
    }
  });

  test('a surface\'s removals drop the item there (no placed list); breaks and labels stay', () => {
    const user = { removed: { home: ['bills'], sidebar: ['bills', 'helpSupport'] } };
    expect(items(R('home', { user }))).toEqual(placed('home').filter((id) => id !== 'bills'));
    expect(items(R('sidebar', { user }))).toEqual(placed('sidebar').filter((id) => id !== 'bills' && id !== 'helpSupport'));
    expect(R('home', { user }).filter((e) => e.kind === 'break')).toHaveLength(LAY.home.filter((e) => e.break).length);
    expect(R('sidebar', { user }).filter((e) => e.kind === 'label').map((e) => e.text)).toEqual(['Records', 'Actions', 'Settings']);
  });

  test('a locked item ignores the removal — with or without a placed list', () => {
    const user = { removed: { home: ['bills', 'log'] } };
    expect(items(R('home', { user, locked: ['bills'] }))).toContain('bills');
    expect(items(R('home', { user, locked: ['bills'] }))).not.toContain('log');
    const withPlaced = { placed: { home: [{ item: 'cases' }] }, removed: { home: ['bills'] } };
    expect(items(R('home', { user: withPlaced, locked: ['bills'] }))).toContain('bills');
    expect(items(R('home', { user: withPlaced }))).not.toContain('bills');
  });

  test('ids missing from the effective registry drop silently — base, placed, removed alike', () => {
    const eff = ALL.filter((id) => id !== 'contacts');
    const user = { placed: { home: [{ item: 'nope' }, { item: 'contacts' }, { item: 'cases' }, { item: 'firm:gone' }] }, removed: { home: ['alsoNope'] } };
    expect(items(R('home', { user, effective: eff }))).not.toContain('contacts');
    expect(items(R('home', { user, effective: eff }))).not.toContain('nope');
    expect(items(R('home', { user, effective: eff }))[0]).toBe('cases');
    expect(items(R('sidebar', { effective: eff }))).not.toContain('contacts');
  });

  test('a placed list IS the order; base items neither placed nor removed slot in after their nearest preceding base item', () => {
    const user = { placed: { home: [{ item: 'comms' }, { item: 'cases' }, { break: true }, { item: 'moreAutomations' }] }, removed: { home: ['tasks'] } };
    // base home: cases contacts appts | bills pipeline events | tasks newClient log | custom moreFeatures comms
    expect(shape(R('home', { user }))).toEqual([
      'comms', 'cases', 'contacts', 'appts', 'bills', 'pipeline', 'events', 'newClient', 'log', 'custom', 'moreFeatures',
      '|', 'moreAutomations']);
    const out = R('home', { user });
    expect(out.filter((e) => e.origin === 'user').map((e) => e.id || '|')).toEqual(['comms', 'cases', '|', 'moreAutomations']);
    expect(out.find((e) => e.id === 'contacts').origin).toBe('default');
  });

  test('no earlier base item in the output → first; a run of missing items keeps its base order', () => {
    const base = [{ item: 'a' }, { item: 'b' }, { break: true }, { item: 'c' }, { item: 'd' }];
    const r = (user) => shape(VL.resolveLayout('home', { base, user, effective: ['a', 'b', 'c', 'd', 'x'] }));
    expect(r({ placed: { home: [{ item: 'd' }] } })).toEqual(['a', 'b', 'c', 'd']);
    expect(r({ placed: { home: [{ item: 'x' }, { item: 'c' }] } })).toEqual(['a', 'b', 'x', 'c', 'd']);
    expect(r({ placed: { home: [{ item: 'c' }, { break: true }, { item: 'a' }] } })).toEqual(['c', 'd', '|', 'a', 'b']);
    expect(r({ placed: { home: [] } })).toEqual(['a', 'b', 'c', 'd']);          // emptied: the base items, no base breaks
  });

  test('an item NEW to the base layout appears for a customized user, next to its base neighbour', () => {
    const base = LAY.home.slice();
    base.splice(base.findIndex((e) => e.item === 'appts') + 1, 0, { item: 'calendar' });
    const user = { placed: { home: [{ item: 'log' }, { item: 'appts' }, { break: true }, { item: 'cases' }] } };
    const out = shape(VL.resolveLayout('home', { base, user, effective: ALL }));
    expect(out.indexOf('calendar')).toBe(out.indexOf('appts') + 1);
  });

  test('an explicit placement beats a removal; an item is placed once (the first)', () => {
    const user = { placed: { home: [{ item: 'cases' }, { item: 'cases' }, { item: 'bills' }] }, removed: { home: ['cases', 'contacts'], sidebar: ['cases'] } };
    const out = items(R('home', { user }));
    expect(out.filter((id) => id === 'cases')).toHaveLength(1);
    expect(out[0]).toBe('cases');
    expect(out).not.toContain('contacts');
    expect(items(R('sidebar', { user }))).not.toContain('cases');   // the sidebar has no placed list; its own list removes it
    expect(items(R('sidebar', { user }))).toContain('contacts');    // …and Home's removal of contacts is Home's alone
  });

  test('breaks are Home\'s, labels the sidebar\'s; labels are plain 1–40 text', () => {
    const user = { placed: {
      home: [{ label: 'X' }, { item: 'cases' }, { break: true }, { item: 'log' }],
      sidebar: [{ break: true }, { label: '  Mine  ' }, { label: '' }, { label: 'y'.repeat(41) }, { label: '<b>x</b>' }, { item: 'cases' }],
    } };
    expect(shape(R('home', { user })).slice(0, 3)).toEqual(['cases', 'contacts', 'appts']);
    expect(R('home', { user }).filter((e) => e.kind === 'label')).toEqual([]);
    const sb = R('sidebar', { user });
    expect(sb.filter((e) => e.kind === 'break')).toEqual([]);
    expect(sb.filter((e) => e.kind === 'label').map((e) => e.text)).toEqual(['Mine', '<b>x</b>']);
  });

  test('junk never throws and never blocks: anything malformed is ignored', () => {
    const junk = [undefined, null, 0, 'x', [], {}, { placed: 5 }, { placed: { home: 'x', sidebar: {} } },
      { placed: { home: [null, 1, 'cases', [], { item: 5 }, { item: '' }, { break: 'yes' }] }, removed: 'cases' },
      { removed: [null, 7, {}, ['cases']] }, { removed: { home: 'cases', sidebar: { x: 1 } } }];
    for (const user of junk) {
      for (const sf of ['home', 'sidebar']) {
        let out;
        expect(() => { out = R(sf, { user }); }).not.toThrow();
        expect(Array.isArray(out)).toBe(true);
      }
    }
    for (const o of [undefined, null, {}, { base: 'x', effective: 'y', locked: 5 }]) {
      expect(VL.resolveLayout('home', o)).toEqual([]);
    }
    // the junk entries are skipped, the good one placed: the same as a list of just it
    expect(R('home', { user: { placed: { home: [null, { item: 5 }, { item: 'log' }, 'x'] } } }))
      .toEqual(R('home', { user: { placed: { home: [{ item: 'log' }] } } }));
    // the old flat removed array removes nothing (the server refuses it)
    expect(items(R('home', { user: { removed: ['bills'] } }))).toEqual(placed('home'));
  });

  test('prototype names are ids like any other (never Object.prototype)', () => {
    const user = { placed: { home: [{ item: 'toString' }, { item: 'constructor' }, { item: '__proto__' }] }, removed: { home: ['hasOwnProperty'], __proto__: ['cases'] } };
    expect(items(R('home', { user, effective: ALL }))).toEqual(placed('home'));
    expect(items(R('home', { user, effective: ALL.concat('toString') }))).toContain('toString');
    expect(items(R('home', { user, effective: ALL.concat('toString') })).filter((id) => !placed('home').includes(id))).toEqual(['toString']);
  });

  test('deterministic: a function of the inputs only — order of effective / locked, repeat calls, no mutation', () => {
    const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
    const user = deepFreeze({ placed: { home: [{ item: 'events' }, { break: true }, { item: 'cases' }], sidebar: [{ label: 'Mine' }, { item: 'log' }] }, removed: { home: ['bills', 'tasks'], sidebar: ['bills', 'tasks'] } });
    const base = deepFreeze(JSON.parse(JSON.stringify(LAY)));
    for (const sf of ['home', 'sidebar']) {
      const a = VL.resolveLayout(sf, { base: base[sf], user, effective: ALL, locked: ['tasks', 'log'] });
      const b = VL.resolveLayout(sf, { base: base[sf], user, effective: ALL.slice().reverse(), locked: ['log', 'tasks'] });
      const c = VL.resolveLayout(sf, { base: base[sf], user, effective: ALL.map((id) => ({ id, label: id })), locked: ['tasks', 'log'] });
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(VL.resolveLayout(sf, { base: base[sf], user, effective: ALL, locked: ['tasks', 'log'] })).toEqual(a);
    }
  });

  test('removals are per surface: hiding Billing from the sidebar leaves Home\'s Billing tile, and the reverse', () => {
    const sbOnly = { removed: { sidebar: ['bills'] } };
    expect(items(R('sidebar', { user: sbOnly }))).not.toContain('bills');
    expect(items(R('home', { user: sbOnly }))).toEqual(placed('home'));
    const homeOnly = { removed: { home: ['bills'] } };
    expect(items(R('home', { user: homeOnly }))).not.toContain('bills');
    expect(items(R('sidebar', { user: homeOnly }))).toEqual(placed('sidebar'));
  });

  test('resetting ONE surface (drop placed[sf] and removed[sf]) restores that surface only', () => {
    const user = { placed: { home: [{ item: 'calendar' }, { item: 'cases' }], sidebar: [{ label: 'Mine' }, { item: 'log' }] },
      removed: { home: ['bills'], sidebar: ['calendar', 'tasks'] } };
    const sidebarBefore = R('sidebar', { user });
    const reset = { placed: { sidebar: user.placed.sidebar }, removed: { sidebar: user.removed.sidebar } };
    expect(R('home', { user: reset })).toEqual(R('home', {}));             // Home: exactly the default
    expect(R('sidebar', { user: reset })).toEqual(sidebarBefore);          // the sidebar: untouched
    expect(items(R('sidebar', { user: reset }))).not.toContain('calendar');
    expect(items(R('home', { user: reset }))).toContain('bills');
  });

  test('the review\'s probe, now isolated: a placed + removed Home leaves the sidebar alone', () => {
    const user = { placed: { home: [{ item: 'bills' }] }, removed: { home: ['bills', 'cases'] } };
    const home = items(R('home', { user }));
    expect(home).toContain('bills');                                    // placed beats removed, on Home
    expect(home).not.toContain('cases');
    expect(items(R('sidebar', { user }))).toEqual(placed('sidebar'));    // no sidebar list: nothing removed there
    const sb = items(R('sidebar', { user: { removed: { sidebar: ['cases'] } } }));
    expect(sb).not.toContain('cases');
    expect(items(R('home', { user: { removed: { sidebar: ['cases'] } } }))).toContain('cases');
  });

  test('the output entries are exactly { kind, id|text, origin } — nothing internal leaks', () => {
    const user = { placed: { sidebar: [{ label: 'A' }, { item: 'cases' }] }, removed: { sidebar: ['log'] } };
    for (const e of R('sidebar', { user })) {
      expect(Object.keys(e).sort()).toEqual(e.kind === 'item' ? ['id', 'kind', 'origin'] : e.kind === 'label' ? ['kind', 'origin', 'text'] : ['kind', 'origin']);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// A page skeleton with the real mounts (Home inside its .home-grid), the
// panels and tab divs; the page's own drill-in, tab and custom-tab code.
// Sidebar mount sits between #tabOpenFiles and #sbAll with no whitespace, so
// the nodes between those two ARE what the mount inserted.
function boot({ extra = '' } = {}) {
  const grid = (sf) => placed(sf).map((k) => REG[k]).filter((it) => it.target)
    .map((it) => `<div id="${it.target}" style="display:none"><iframe data-src="/${it.target}.html"></iframe></div>`).join('');
  const tabs = new Set(['tabHome', 'tabMore', 'tabAdmin', 'tabCustom']);
  for (const it of Object.values(REG)) for (const t of [it.tab, it.tabAlso]) if (t) tabs.add(t);
  const plainTabs = [...tabs].filter((t) => !['tabHome', 'tabMore', 'tabAdmin', 'tabCustom'].includes(t))
    .map((t) => `<div id="${t}" class="tab-main"></div>`).join('');
  const page = `<!DOCTYPE html><html><head>
    <script>${ICON_SRC}</script><script>${REGISTRY_SRC}</script>${extra}<script id="ycLauncher">${RENDERER_SRC}</script>${HIDE_CSS}</head><body>
    <nav id="appSidebar"><div class="sb-item" data-tab="tabHome" onclick="openMainTab('tabHome')"></div>
      <div class="sb-item" id="sbOpenFiles"></div><div id="tabOpenFiles"></div><script>ycLauncher.mount('sidebar')</script><div class="sb-item" id="sbAll" data-tab="tabAll" onclick="openMainTab('tabAll')"></div></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <button id="homeAll" class="home-btn"></button></div>
    <div id="tabAll" class="tab-main"></div>
    <div id="tabCustom" class="tab-main"><iframe id="tabCustomFrame"></iframe></div>
    ${plainTabs}
    <div id="tabMore" class="tab-main"><h1>More</h1><script>ycLauncher.mount('more')</script>${grid('more')}</div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1><script>ycLauncher.mount('admin')</script>${grid('admin')}</div>
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
  let stubSrc = 'var E = (id) => document.getElementById(id);\n' +
    'function syncWorkspaceUrl() {}\nfunction pingBecameVisible() {}\n';
  for (const it of Object.values(w.FEATURE_REGISTRY)) {
    const m = /^(\w+)\(\)$/.exec(it.onclick || '');
    if (!m || stubs.has(m[1])) continue;
    stubs.add(m[1]);
    stubSrc += `function ${m[1]}() { __calls.push('${m[1]}'); ${it.tab ? `openMainTab('${it.tab}');` : ''} }\n`;
  }
  w.eval(stubSrc + CURRENT_SRC + TABS_SRC + CUSTOM_SRC + DRILL_SRC);
  const d = w.document;
  const L = w.ycLauncher;
  const shown = (el) => w.getComputedStyle(el).display !== 'none';
  const active = () => [...d.querySelectorAll('#appSidebar .sb-item.active')].map((e) => e.dataset.tab || e.id);
  const homeGrid = d.querySelector('#tabHome > .home-grid');
  const sbNodes = () => {
    const out = [];
    for (let n = d.getElementById('tabOpenFiles').nextSibling; n && n.id !== 'sbAll'; n = n.nextSibling) out.push(n);
    return out;
  };
  const ser = (nodes) => { const t = d.createElement('div'); nodes.forEach((n) => t.appendChild(n.cloneNode(true))); return t.innerHTML; };
  const html = { home: () => homeGrid.innerHTML, sidebar: () => ser(sbNodes()) };
  const parsed = (sf) => { const t = d.createElement('template'); t.innerHTML = L.build(sf); return t.innerHTML; };
  // what a user sees on a surface, in order: an item id (default element via
  // elementsOf, neutral via data-yc-shortcut), '|' a break, '#text' a label
  const idOf = (el, sf) => {
    if (el.hasAttribute('data-yc-shortcut')) return '+' + el.getAttribute('data-yc-shortcut');
    for (const id of Object.keys(w.FEATURE_REGISTRY)) if (L.elementsOf(id)[sf] === el) return id;
    return '?';
  };
  const seen = (sf) => (sf === 'home' ? [...homeGrid.children] : sbNodes().filter((n) => n.nodeType === 1))
    .filter((el) => shown(el))
    .map((el) => (el.classList.contains('home-break') ? '|' : el.classList.contains('sb-section-label') ? '#' + el.textContent : idOf(el, sf)));
  const observe = () => {
    const mo = new w.MutationObserver(() => {});
    mo.observe(d.body, { subtree: true, childList: true, attributes: true, characterData: true });
    return () => { const r = mo.takeRecords(); mo.disconnect(); return r; };
  };
  return { w, d, L, calls, errors, shown, active, html, parsed, seen, observe, homeGrid, close: () => w.close() };
}

const FIRM_ITEM = { id: 'firm:payroll', label: 'Pay <img src=x onerror=alert(1)>', icon: 'money-check',
  action: { type: 'url', href: 'https://payroll.example.com/', present: 'window' } };
const ui = ({ layout, ro } = {}) => ({ firm: ro ? { registry_overrides: ro } : {}, user: layout ? { layout } : {} });
const LAYOUT = {
  placed: {
    home: [{ item: 'comms' }, { item: 'moreAutomations' }, { item: 'firm:payroll' }, { break: true }, { item: 'calendar' }, { item: 'cases' }],
    sidebar: [{ label: 'Mine <b>' }, { item: 'tasks' }, { item: 'moreAutomations' }, { item: 'firm:payroll' }, { label: 'Rest' }],
  },
  removed: { home: ['bills', 'log'], sidebar: ['bills', 'log'] },
};
const ADMIN = { isAdmin: true, denied: [], customTab: { src: '/c.html', title: 'C' } };

describe('the renderer (for real): default DOM, reversibility, idempotence', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('the mounted surfaces are exactly the markup the S1 helper expands the page with', () => {
    const exp = expandedShellHtml();
    expect(exp).toContain('<div class="home-grid">' + VL.build('home') + '</div>');
    expect(exp).toContain(VL.build('sidebar'));
    expect(t.html.home()).toBe(t.parsed('home'));
    expect(t.html.sidebar()).toBe(t.parsed('sidebar'));
    expect(t.errors).toEqual([]);
  });

  test('applyAccess with no user layout changes nothing on either surface (not a node, not an attribute)', () => {
    const done = t.observe();
    t.L.applyAccess(ADMIN);
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    expect(t.html.home()).toBe(t.parsed('home'));
  });

  test('a layout, then an EMPTY one, restores the default DOM byte for byte — same element objects', () => {
    const before = { cases: t.L.elementsOf('cases'), tasks: t.L.elementsOf('tasks') };
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM] } }) });
    expect(t.html.home()).not.toBe(t.parsed('home'));
    expect(t.html.sidebar()).not.toBe(t.parsed('sidebar'));
    for (const empty of [{}, { placed: {}, removed: {} }, null]) {
      t.L.applyAccess({ ...ADMIN, ui: ui({ layout: empty, ro: { items: [FIRM_ITEM] } }) });
      expect(t.html.home()).toBe(t.parsed('home'));
      expect(t.html.sidebar()).toBe(t.parsed('sidebar'));
      t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM] } }) });
    }
    t.L.applyAccess({ ...ADMIN, ui: ui({}) });
    expect(t.html.sidebar()).toBe(t.parsed('sidebar'));
    expect(t.L.elementsOf('cases')).toEqual(before.cases);
    expect(t.L.elementsOf('tasks').sidebar).toBe(before.tasks.sidebar);
    expect(t.d.querySelectorAll('[data-yc-shortcut], [data-yc-unplaced]')).toHaveLength(0);
  });

  test('re-running with the same state changes nothing (idempotent)', () => {
    const state = { ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM], renames: { cases: { label: 'Matters' } } } }) };
    t.L.applyAccess(state);
    const snap = [t.html.home(), t.html.sidebar()];
    const done = t.observe();
    t.L.applyAccess(state);
    t.L.applyAccess({ customTab: state.customTab });
    expect(done().map((r) => r.type + ' ' + (r.target.id || r.target.nodeName))).toEqual([]);
    expect([t.html.home(), t.html.sidebar()]).toEqual(snap);
  });

  test('what the user sees follows the resolved layout on both surfaces', () => {
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM] } }) });
    t.d.getElementById('sbAdmin').style.display = '';     // loadUserContext's reveal for an SU
    const eff = t.L.effectiveRegistry();
    for (const sf of ['home', 'sidebar']) {
      const want = t.L.resolveLayout(sf, { base: LAY[sf], user: LAYOUT, effective: eff, locked: [] })
        .map((e) => (e.kind === 'break' ? '|' : e.kind === 'label' ? '#' + e.text : (t.L.elementsOf(e.id)[sf] ? e.id : '+' + e.id)));
      expect([sf, t.seen(sf)]).toEqual([sf, want]);
    }
    expect(t.seen('home').slice(0, 6)).toEqual(['comms', '+moreAutomations', '+firm:payroll', '|', '+calendar', 'cases']);
    // the user's own entries, in the user's order (base items slot in around them)
    const mine = ['#Mine <b>', 'tasks', '+moreAutomations', '+firm:payroll', '#Rest'];
    expect(t.seen('sidebar').filter((x) => mine.includes(x))).toEqual(mine);
  });
});

describe('the renderer (for real): moved elements keep what other code holds', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('ids, listeners and badges survive a move; the moved item still works by click', () => {
    const tasks = t.L.elementsOf('tasks').sidebar;
    const badge = t.d.getElementById('sbTasksBadge');
    badge.textContent = '7';
    badge.style.display = '';
    let heard = 0;
    tasks.addEventListener('click', () => { heard++; });
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT }) });
    expect(t.d.getElementById('sbTasksBadge')).toBe(badge);
    expect(tasks.contains(badge)).toBe(true);
    expect(badge.textContent).toBe('7');
    expect(t.L.elementsOf('tasks').sidebar).toBe(tasks);
    expect(tasks.isConnected).toBe(true);
    for (const id of ['sbCustom', 'tabCustomButton', 'sbAdmin', 'sbComms', 'homeComms', 'sbCommsBadge']) {
      expect([id, t.d.querySelectorAll('#' + id).length]).toEqual([id, 1]);
    }
    tasks.click();
    expect(heard).toBe(1);
    expect(t.w.currentMainTabId()).toBe('tabTasks');
    expect(t.active()).toEqual(['tabTasks']);
  });

  test('a removed item stays in the DOM, hidden by data-yc-unplaced (not style.display) — and exec still reaches it', () => {
    const RM = { removed: { home: ['comms', 'log'], sidebar: ['comms', 'helpSupport', 'log'] } };
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: RM }) });
    const c = t.L.elementsOf('comms');
    for (const el of [c.sidebar, c.home, t.L.elementsOf('helpSupport').sidebar]) {
      expect(el.isConnected).toBe(true);
      expect(el.hasAttribute('data-yc-unplaced')).toBe(true);
      expect(el.style.display).toBe('');
      expect(t.shown(el)).toBe(false);
    }
    // no placed list: hidden IN PLACE — the DOM order is the default one
    const order = [...t.homeGrid.children];
    t.L.applyAccess({ ...ADMIN, ui: ui({}) });
    expect([...t.homeGrid.children]).toEqual(order);
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: RM }) });
    // style.display written by its owner cannot bring it back
    c.sidebar.style.display = '';
    expect(t.shown(c.sidebar)).toBe(false);
    // the feature is still there: All lists it, exec() clicks the hidden element
    expect(t.L.effectiveRegistry().map((e) => e.id)).toEqual(expect.arrayContaining(['comms', 'helpSupport', 'log']));
    expect(t.L.exec('comms')).toBe(true);
    expect(t.w.currentMainTabId()).toBe('tabComms');
    expect(t.L.exec('helpSupport')).toBe(true);
    expect(t.calls).toContain('reportIssue');
  });

  test('per surface on screen: Billing hidden from the sidebar keeps its Home tile; resetting the sidebar restores it alone', () => {
    const layout = { placed: { home: [{ item: 'comms' }, { item: 'cases' }] }, removed: { sidebar: ['bills'], home: ['log'] } };
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout }) });
    const b = t.L.elementsOf('bills');
    expect([t.shown(b.sidebar), t.shown(b.home)]).toEqual([false, true]);
    expect(t.shown(t.L.elementsOf('log').sidebar)).toBe(true);
    const home = t.html.home();
    t.L.applyAccess({ ui: ui({ layout: { placed: layout.placed, removed: { home: layout.removed.home } } }) });   // reset the sidebar
    expect(t.html.sidebar()).toBe(t.parsed('sidebar'));
    expect(t.html.home()).toBe(home);
    t.L.applyAccess({ ui: ui({ layout: {} }) });                                                                 // and Home
    expect(t.html.home()).toBe(t.parsed('home'));
  });

  test('a removed item placed elsewhere by the user shows there; hidden ones keep a slot by the anchor rule', () => {
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: { placed: { sidebar: [{ item: 'log' }, { item: 'cases' }] }, removed: { sidebar: ['log', 'contacts'], home: ['log'] } } }) });
    const sb = t.seen('sidebar');
    expect(sb[0]).toBe('log');                          // placed: shown, first
    expect(sb.indexOf('cases')).toBeGreaterThan(0);
    expect(sb).not.toContain('contacts');               // removed, not placed
    expect(t.seen('home')).not.toContain('log');
    expect(t.L.elementsOf('contacts').sidebar.isConnected).toBe(true);
  });
});

describe('the renderer (for real): neutral shortcuts', () => {
  let t;
  beforeEach(() => {
    t = boot();
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM] } }) });
  });
  afterEach(() => t.close());
  const neutral = (sf, id) => t.d.querySelector(`${sf === 'home' ? '#tabHome .home-grid > .home-btn' : '#appSidebar > .sb-item'}[data-yc-shortcut="${id}"]`);

  test('the surface\'s grammar; no id, no data-target, no data-exclusive-group; label as text; icon from the entry', () => {
    const h = neutral('home', 'moreAutomations');
    expect(h.tagName).toBe('BUTTON');
    expect(h.className).toBe('home-btn');
    expect(h.querySelector('i').className).toBe('fa-solid fa-robot fa-2xl');
    expect(h.querySelectorAll('br')).toHaveLength(2);
    expect(h.lastChild.nodeValue).toBe('Automations');
    const s = neutral('sidebar', 'moreAutomations');
    expect(s.className).toBe('sb-item');
    expect(s.querySelector('i').className).toBe('fa-solid fa-robot');
    expect(s.querySelector('span').textContent).toBe('Automations');
    expect(s.getAttribute('title')).toBe('Automations');            // skinny mode's tooltip
    for (const el of t.d.querySelectorAll('[data-yc-shortcut]')) {
      for (const a of ['id', 'data-target', 'data-exclusive-group', 'onclick', 'data-tab']) expect([el.getAttribute('data-yc-shortcut'), a, el.hasAttribute(a)]).toEqual([el.getAttribute('data-yc-shortcut'), a, false]);
    }
    // a firm label with markup is TEXT; the icon class comes from the validated slug
    const f = neutral('home', 'firm:payroll');
    expect(f.lastChild.nodeValue).toBe(FIRM_ITEM.label);
    expect(t.d.querySelector('img')).toBe(null);
    expect(f.querySelector('i').className).toBe('fa-solid fa-money-check fa-2xl');
    // the page's data-target count is the grids' own, and no id repeats
    expect(t.d.querySelectorAll('[data-target]').length).toBe(['more', 'admin'].flatMap(placed).filter((k) => REG[k].target).length);
    const ids = [...t.d.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a click runs exec(id): a More panel drills in, a sidebar-only item opens its tab, a firm item dispatches', () => {
    neutral('home', 'moreAutomations').click();
    expect(t.w.currentMainTabId()).toBe('tabMore');
    expect(t.shown(t.d.getElementById('automationsDiv'))).toBe(true);
    expect(t.d.getElementById('tabMore').classList.contains('drill-active')).toBe(true);
    neutral('home', 'calendar').click();
    expect(t.w.currentMainTabId()).toBe('tabCalendar');
    expect(t.active()).toEqual(['tabCalendar']);
    neutral('sidebar', 'firm:payroll').click();
    expect(t.calls.find((c) => Array.isArray(c) && c[0] === 'open')).toEqual(['open', 'https://payroll.example.com/', '_blank', 'noopener']);
  });

  test('a sidebar shortcut closes the phone drawer, a firm item opening a new window included (review N6)', () => {
    t.d.body.classList.add('sidebar-mobile-open');
    neutral('sidebar', 'firm:payroll').click();
    expect(t.calls.some((c) => Array.isArray(c) && c[0] === 'open')).toBe(true);
    expect(t.d.body.classList.contains('sidebar-mobile-open')).toBe(false);
  });

  test('neutral shortcuts are not launcher elements: elementsOf / exec never reach them', () => {
    expect(t.L.elementsOf('moreAutomations')).toEqual({ more: expect.anything() });
    expect(Object.keys(t.L.elementsOf('calendar'))).toEqual(['sidebar']);
    expect(t.L.elementsOf('firm:payroll')).toEqual({});
  });
});

describe('the renderer (for real): composition with denies, firm hides, renames, locks, the custom tab', () => {
  let t;
  beforeEach(() => { t = boot(); });
  afterEach(() => t.close());

  test('a denied / firm-hidden item the user placed stays hidden: no neutral is drawn, a default element stays hidden', () => {
    const layout = { placed: { home: [{ item: 'cases' }, { item: 'moreAutomations' }, { item: 'firm:payroll' }, { item: 'moreViews' }] } };
    t.L.applyAccess({ ...ADMIN, denied: ['cases', 'moreAutomations'], ui: ui({ layout, ro: { items: [FIRM_ITEM], hidden: ['firm:payroll', 'moreViews'] } }) });
    expect(t.d.querySelectorAll('[data-yc-shortcut]')).toHaveLength(0);
    const c = t.L.elementsOf('cases');
    expect([t.shown(c.home), t.shown(c.sidebar), c.home.isConnected]).toEqual([false, false, true]);
    expect(t.seen('home')).not.toContain('cases');
    // lifting the deny: cases takes the user's slot, the neutral appears
    t.L.applyAccess({ denied: [] });
    const home = t.seen('home');
    expect(home[0]).toBe('cases');
    expect(home).toContain('+moreAutomations');
  });

  test('renames follow a moved element and a neutral shortcut; dropping the rename restores both', () => {
    const layout = { placed: { sidebar: [{ item: 'moreAutomations' }, { item: 'cases' }] } };
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout, ro: { renames: { cases: { label: 'Matters' }, moreAutomations: { label: 'Robots' } } } }) });
    const cs = t.L.elementsOf('cases').sidebar;
    const n = t.d.querySelector('#appSidebar [data-yc-shortcut="moreAutomations"]');
    expect([cs.querySelector('span').textContent, cs.getAttribute('title')]).toEqual(['Matters', 'Matters']);
    expect([n.querySelector('span').textContent, n.getAttribute('title')]).toEqual(['Robots', 'Robots']);
    t.L.applyAccess({ ui: ui({ layout }) });
    expect([cs.querySelector('span').textContent, cs.getAttribute('title')]).toEqual(['Cases', 'Cases']);
    expect(n.querySelector('span').textContent).toBe('Automations');
  });

  test('a firm-locked item ignores the user\'s removal, on both surfaces', () => {
    const RM = { removed: { home: ['bills', 'log'], sidebar: ['bills', 'log'] } };
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: RM, ro: { locked: ['bills'] } }) });
    const b = t.L.elementsOf('bills');
    expect([t.shown(b.home), t.shown(b.sidebar)]).toEqual([true, true]);
    expect(t.shown(t.L.elementsOf('log').sidebar)).toBe(false);
    t.L.applyAccess({ ui: ui({ layout: RM }) });   // the lock lifted: the removal acts
    expect(t.shown(b.home)).toBe(false);
  });

  test('the custom tab where the user put it: applyCustomTab finds it by id, rewrites it there, hides it there', () => {
    t.L.applyAccess({ ...ADMIN, customTab: null, ui: ui({ layout: { placed: { sidebar: [{ item: 'custom' }, { item: 'cases' }] } } }) });
    t.w.applyCustomTab({ src: '/forms.html', title: 'My Forms', icon: 'book' });
    expect(t.seen('sidebar')[0]).toBe('custom');
    expect(t.d.getElementById('sbCustom').textContent).toMatch(/My Forms/);
    t.w.applyCustomTab(null);
    expect(t.shown(t.d.getElementById('sbCustom'))).toBe(false);
    expect(t.d.getElementById('sbCustom').isConnected).toBe(true);
    expect(t.seen('sidebar')[0]).not.toBe('custom');
  });

  test('admin-gated Admin: a non-SU never sees it, wherever the user placed it', () => {
    t.L.applyAccess({ isAdmin: false, ui: ui({ layout: { placed: { home: [{ item: 'admin' }, { item: 'adminDbConsole' }], sidebar: [{ item: 'admin' }] } } }) });
    t.w.E('sbAdmin').style.display = 'none';      // loadUserContext's own hide for a non-SU
    expect(t.d.querySelectorAll('[data-yc-shortcut]')).toHaveLength(0);
    expect(t.seen('sidebar')).not.toContain('admin');
  });
});

describe('the renderer (for real): breaks, labels, highlights', () => {
  test('a user break is a .home-break sentinel; a user label an .sb-section-label (text, never markup)', () => {
    const t = boot();
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: LAYOUT, ro: { items: [FIRM_ITEM] } }) });
    const kids = [...t.homeGrid.children];
    const brk = kids.find((el) => el.classList.contains('home-break'));
    expect(brk.parentElement).toBe(t.homeGrid);
    expect(kids.indexOf(brk)).toBe(kids.indexOf(t.homeGrid.querySelector('[data-yc-shortcut="firm:payroll"]')) + 1);
    const labels = [...t.d.querySelectorAll('#appSidebar > .sb-section-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Mine <b>', 'Rest']);
    expect(t.d.querySelector('#appSidebar b')).toBe(null);
    t.close();
  });

  test('moved items light up; a neutral sidebar shortcut for an item with a tab lights up like the real one', () => {
    // a registry item with its own tab that the base sidebar does not carry
    const extra = `<script>FEATURE_REGISTRY.qaCal = { label: 'QA Cal', icon: 'flag', onclick: 'openCalendarTab()', tab: 'tabCalendar' };
      DEFAULT_LAYOUTS.home.push({ item: 'qaCal' });</script>`;
    const t = boot({ extra });
    t.L.applyAccess({ ...ADMIN, ui: ui({ layout: { placed: { sidebar: [{ item: 'qaCal' }, { item: 'calendar' }, { item: 'cases' }] } } }) });
    const n = t.d.querySelector('#appSidebar [data-yc-shortcut="qaCal"]');
    expect(n.dataset.tab).toBe('tabCalendar');
    n.click();
    expect(t.w.currentMainTabId()).toBe('tabCalendar');
    expect(t.active()).toEqual(['tabCalendar', 'tabCalendar']);
    expect(n.classList.contains('active')).toBe(true);
    t.L.exec('cases');
    expect(t.L.elementsOf('cases').sidebar.classList.contains('active')).toBe(true);
    expect(n.classList.contains('active')).toBe(false);
    // the item new to the base Home layout appears on Home (no Home placed list)
    expect(t.seen('home')).toContain('qaCal');
    t.close();
  });
});

describe('computeEffective is pure (S3.2 review carry-over)', () => {
  test('the group order rides on the list; groups() and the effective registry are untouched by any other call', () => {
    const t = boot();
    t.L.applyAccess({ ...ADMIN, ui: ui({}) });
    const groups = t.L.groups(), eff = JSON.stringify(t.L.effectiveRegistry());
    expect(groups).not.toContain('Firm');
    const list = t.L.computeEffective({ isAdmin: true, ui: ui({ ro: { items: [FIRM_ITEM] } }) });
    expect(list.groups).toEqual(['Home', 'Records', 'Actions', 'Settings', 'More', 'Firm', 'Admin']);
    expect(Object.keys(list)).not.toContain('groups');
    expect(t.L.groups()).toEqual(groups);
    expect(JSON.stringify(t.L.effectiveRegistry())).toBe(eff);
    // …and two calls with the same input are equal (nothing carried between them)
    const a = t.L.computeEffective({ isAdmin: true, ui: ui({ ro: { items: [FIRM_ITEM] } }) });
    const b = t.L.computeEffective({ isAdmin: true, ui: ui({ ro: { items: [FIRM_ITEM] } }) });
    expect([JSON.stringify(a), a.groups]).toEqual([JSON.stringify(b), b.groups]);
    // applyAccess is what moves groups()
    t.L.applyAccess({ ui: ui({ ro: { items: [FIRM_ITEM] } }) });
    expect(t.L.groups()).toContain('Firm');
    t.close();
  });
});
