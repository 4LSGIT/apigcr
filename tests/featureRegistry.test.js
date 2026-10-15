// tests/featureRegistry.test.js
//
/**
 * ui-custom S1 — the launcher registry (public/js/featureRegistry.js) and the
 * shell's renderer (the `<script id="ycLauncher">` block in public/index.html).
 *
 * The four launcher surfaces (Home tiles; the sidebar's Records / Actions /
 * Settings sections; the More Features and Admin grids) are rendered from data
 * at parse time. What used to be guaranteed by the markup simply existing now
 * depends on three things lining up, and this file fences each:
 *
 *   1. THE DATA. Every layout entry names a registry item; every registry item
 *      is placed somewhere; ids are unique — an object literal with a repeated
 *      key keeps the LAST one without a word, so uniqueness is checked on the
 *      source text; grid ids carry their prefix; a panel tile has no onclick
 *      (the delegated [data-target] listener opens it — an onclick would fire
 *      twice) and names a real panel div in its own tab; every sidebar
 *      data-tab names a real tab.
 *   2. THE MOUNTS. One per surface, in page order, each inside the container
 *      the surface lives in — before the boot script, which looks the items
 *      up by id.
 *   3. THE MECHANISM, RUN FOR REAL. jsdom executes the page's own renderer
 *      over the real registry, mount by mount, inside a skeleton of each
 *      container: the markup lands in the mount's place, as DIRECT children
 *      (ensureStrip(), exitDrillMode() and the drill-in/phone CSS select with
 *      ">"), and the mount script removes itself.
 *
 * Wiring of particular items (Comms, Calendar, the Config label) is asserted
 * where it was decided — commsShell, unifiedEventsU9.shell, fieldDefs.cfg1 —
 * against the expanded page (tests/helpers/shellHtml.js).
 *
 * Mutation-checked: a duplicated registry key; an orphaned item; a layout ref
 * to a missing id; a panel tile given an onclick; a tile targeting a panel in
 * the other grid; a sidebar data-tab to nowhere; a mount moved after the boot
 * script; mount() not removing its script; insertion as a wrapper instead of
 * direct children.
 *
 * Run:  npx jest tests/featureRegistry.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { rawShellHtml, expandedShellHtml, loadLauncher, MOUNT } = require('./helpers/shellHtml');

const ROOT = path.join(__dirname, '..');
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'public/js/featureRegistry.js'), 'utf8');
const RAW = rawShellHtml();
const { launcher: LAUNCHER, registry: REG, layouts: LAY, warnings: WARNINGS } = loadLauncher(RAW);
const RENDERER_SRC = RAW.match(/<script id="ycLauncher">([\s\S]*?)<\/script>/)[1];
const SURFACES = ['sidebar', 'home', 'more', 'admin'];

/** The markup of one tab-main div in the raw page, up to the next tab-main. */
function tabDiv(id) {
  const a = RAW.indexOf(`<div id="${id}" class="tab-main"`);
  if (a < 0) throw new Error('no tab-main ' + id);
  const b = RAW.indexOf('class="tab-main"', a + 20);
  return RAW.slice(a, b < 0 ? undefined : b);
}

describe('the registry data', () => {
  test('the shipped layouts render without a skipped entry', () => {
    for (const sf of SURFACES) expect(LAUNCHER.build(sf).length).toBeGreaterThan(0);
    expect(WARNINGS).toEqual([]);   // collected by the helper's console stub during the builds above
    expect(Object.keys(LAY).sort()).toEqual([...SURFACES].sort());
    for (const s of SURFACES) for (const e of LAY[s]) {
      const kinds = ['item', 'break', 'label'].filter((k) => e[k] != null);
      expect(kinds).toHaveLength(1);
      if (e.item != null) expect(Object.prototype.hasOwnProperty.call(REG, e.item)).toBe(true);
      if (e.label != null) expect(s).toBe('sidebar');   // only the sidebar draws section labels
    }
  });

  test('ids are unique in the SOURCE (a repeated object key silently keeps the last)', () => {
    const body = REGISTRY_SRC.slice(REGISTRY_SRC.indexOf('window.FEATURE_REGISTRY = {'), REGISTRY_SRC.indexOf('window.DEFAULT_LAYOUTS = {'));
    const keys = [...body.matchAll(/^ {2}([A-Za-z_$][\w$]*): \{/gm)].map((m) => m[1]);
    expect(keys.length).toBe(Object.keys(REG).length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every item is placed on a surface, ids are camelCase, grid ids carry their prefix', () => {
    const placed = new Set(SURFACES.flatMap((s) => LAY[s].filter((e) => e.item).map((e) => e.item)));
    expect(Object.keys(REG).filter((k) => !placed.has(k))).toEqual([]);
    for (const k of Object.keys(REG)) expect(k).toMatch(/^[a-z][A-Za-z0-9]*$/);
    for (const e of LAY.more.filter((x) => x.item)) expect(e.item).toMatch(/^more[A-Z]/);
    for (const e of LAY.admin.filter((x) => x.item)) expect(e.item).toMatch(/^admin[A-Z]/);
    for (const [k, it] of Object.entries(REG)) {
      expect([k, typeof it.label, typeof it.icon]).toEqual([k, 'string', 'string']);
    }
  });

  test('grid panel tiles have NO onclick and open a real panel in their own tab, in their own group', () => {
    for (const [surface, tab] of [['more', 'tabMore'], ['admin', 'tabAdmin']]) {
      const html = tabDiv(tab);
      for (const e of LAY[surface].filter((x) => x.item)) {
        const it = REG[e.item];
        if (it.target == null) { expect([e.item, typeof it.onclick]).toEqual([e.item, 'string']); continue; }
        expect([e.item, it.onclick]).toEqual([e.item, undefined]);
        expect([e.item, it.group]).toEqual([e.item, surface]);
        expect([e.item, html.includes(`<div id="${it.target}"`)]).toEqual([e.item, true]);
      }
    }
  });

  test('every sidebar data-tab / data-tab-also names a real tab; dialogs have none', () => {
    for (const e of LAY.sidebar.filter((x) => x.item)) {
      const it = REG[e.item];
      for (const t of [it.tab, it.tabAlso].filter(Boolean)) expect([e.item, RAW.includes(`<div id="${t}" class="tab-main"`)]).toEqual([e.item, true]);
    }
    // the highlight rule: an item that opens a dialog must never be lit
    expect(REG.newClient.tab).toBeUndefined();
    expect(REG.helpSupport.tab).toBeUndefined();
  });
});

describe('the mounts in public/index.html', () => {
  test('one per surface, in page order, each inside its container and before the boot', () => {
    const sites = [...RAW.matchAll(MOUNT)];
    expect(sites.map((m) => m[1])).toEqual(SURFACES);
    const at = (s) => sites.find((m) => m[1] === s).index;
    const within = (s, open, close) => {
      const a = RAW.indexOf(open), b = RAW.indexOf(close, a);
      expect([s, a < at(s) && at(s) < b]).toEqual([s, true]);
    };
    within('sidebar', '<nav id="appSidebar"', '</nav>');
    within('home', '<div id="tabHome" class="tab-main">', '<div class="home-search">');
    // Home's tiles mount inside their flex row container (ui-custom S4a)
    expect(RAW).toContain(`<div class="home-grid"><script>ycLauncher.mount('home')</script></div>`);
    within('more', '<div id="tabMore" class="tab-main">', '<div class="more-egg-row">');
    within('admin', '<div id="tabAdmin" class="tab-main"', '<div id="sequencesDiv"');
    // the renderer is defined before the first mount; the boot runs after the last
    expect(RAW.indexOf('<script id="ycLauncher">')).toBeLessThan(at('sidebar'));
    expect(RAW.indexOf('src="/js/featureRegistry.js"')).toBeLessThan(RAW.indexOf('<script id="ycLauncher">'));
    expect(at('admin')).toBeLessThan(RAW.indexOf('\n    initAuth();\n'));
  });

  test('the expanded page still holds every element other code looks up by id', () => {
    const html = expandedShellHtml();
    for (const id of ['sbCustom', 'tabCustomButton', 'sbAdmin', 'sbComms', 'homeComms', 'sbTasksBadge', 'sbCommsBadge']) {
      expect([id, (html.match(new RegExp(`id="${id}"`, 'g')) || []).length]).toEqual([id, 1]);
    }
  });
});

describe('mount(), run for real in jsdom', () => {
  // A skeleton of each container, with the mount where the page has it and the
  // page's own neighbours either side, so order and parentage are observable.
  const PAGE = `<!DOCTYPE html><html><head>
    <script>${REGISTRY_SRC}</script><script id="ycLauncher">${RENDERER_SRC}</script></head><body>
    <nav id="appSidebar"><div id="tabOpenFiles"></div>
      <script>ycLauncher.mount('sidebar')</script>
      <div class="sb-spacer"></div></nav>
    <div id="tabHome" class="tab-main"><br><br>
      <div class="home-grid"><script>ycLauncher.mount('home')</script></div>
      <div class="home-search"></div></div>
    <div id="tabMore" class="tab-main"><h1>More</h1>
      <script>ycLauncher.mount('more')</script>
      <div class="more-egg-row"></div><div id="manualsDiv"></div></div>
    <div id="tabAdmin" class="tab-main"><h1>Admin</h1>
      <script>ycLauncher.mount('admin')</script>
      <div id="sequencesDiv"></div></div>
  </body></html>`;
  let doc, win;
  beforeAll(() => {
    const dom = new JSDOM(PAGE, { runScripts: 'dangerously' });
    win = dom.window; doc = win.document;
  });
  afterAll(() => win.close());

  test('every mount removed its own script', () => {
    expect(doc.querySelectorAll('body script')).toHaveLength(0);
  });

  test('the markup lands in the mount\'s place as DIRECT children, between the page\'s neighbours', () => {
    const kids = (sel) => [...doc.querySelector(sel).children];
    for (const [tab, after, before, n] of [['#tabMore', 'H1', 'more-egg-row', LAY.more.filter((e) => e.item).length],
                                           ['#tabAdmin', 'H1', 'sequencesDiv', LAY.admin.filter((e) => e.item).length]]) {
      const tiles = doc.querySelectorAll(`${tab} > .big-button`);
      expect(tiles).toHaveLength(n);
      expect(doc.querySelectorAll(`${tab} > br`)).toHaveLength(LAY[tab === '#tabMore' ? 'more' : 'admin'].filter((e) => e.break).length * 2);
      const k = kids(tab);
      expect(k[k.indexOf(tiles[0]) - 1].tagName).toBe(after);
      const next = k[k.indexOf(tiles[tiles.length - 1]) + 1];
      expect(next.className || next.id).toBe(before);
    }
    // Home: direct children of its .home-grid container (S4a), which sits
    // right before the quick search; a break is a .home-break sentinel
    const home = doc.querySelectorAll('#tabHome > .home-grid > .home-btn');
    expect(home).toHaveLength(LAY.home.filter((e) => e.item).length);
    expect(doc.querySelectorAll('#tabHome > .home-grid > .home-break')).toHaveLength(LAY.home.filter((e) => e.break).length);
    expect(home[home.length - 1].nextElementSibling).toBe(null);
    expect(home[0].parentElement.nextElementSibling.className).toBe('home-search');
    const sb = doc.querySelectorAll('#appSidebar > .sb-item');
    expect(sb).toHaveLength(LAY.sidebar.filter((e) => e.item).length);
    expect(doc.querySelectorAll('#appSidebar > .sb-section-label')).toHaveLength(LAY.sidebar.filter((e) => e.label).length);
    expect(sb[0].previousElementSibling.previousElementSibling.id).toBe('tabOpenFiles');
  });

  test('the elements boot looks up are there, in their pre-login state', () => {
    expect(doc.getElementById('sbAdmin').style.display).toBe('none');
    expect(doc.getElementById('sbTasksBadge').style.display).toBe('none');
    expect(doc.getElementById('sbCustom').textContent.trim()).toBe(REG.custom.label);
    expect(doc.getElementById('tabCustomButton').className).toBe('home-btn');
    expect(doc.querySelector('#appSidebar [data-tab="tabMore"]').dataset.tabAlso).toBe('tabSettings');
    // panel tiles carry no onclick; the delegated listener opens them
    expect(doc.querySelectorAll('.big-button[data-target][onclick]')).toHaveLength(0);
  });

  test('called outside a parsing inline script, mount() refuses loudly', () => {
    expect(() => win.ycLauncher.mount('more')).toThrow(/while the page parses/);
  });
});
