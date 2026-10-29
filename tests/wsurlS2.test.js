/**
 * wsurl S2 — the workspace URL remembers the open drill panel of a page.
 *
 *   ?open=firm:more~<registryId>[~<pane rest>]   firm:admin~<registryId>[~…]
 *
 * Since launcher-nits C4 More Features and Admin are the FIRM'S PAGES
 * (firm:more / firm:admin — tabs in #ycPages, their tiles neutrals); the
 * static #tabMore / #tabAdmin hubs, their default tiles and the "unplaced"
 * default tile are gone. Here they are ycPage-5 / ycPage-6, first in
 * #ycPages as the firm's item order puts them.
 *
 * The REAL shell functions, extracted from public/index.html (the fnSrc
 * pattern of tests/unifiedEventsU9.shell.test.js), run over a DOM shaped
 * like the More / Admin pages and the panel stage (ui-custom S6c-4): tiles
 * carrying data-target on the pages, their panels on #ycPanels with their
 * lazy iframes, a neutral tile the firm placed on More for an Admin panel
 * (Users), plus an action tile (a dialog) and a frame in a Swal. The stage
 * itself runs for real too (drillMemory, stageShow, drillOpen, stageSync,
 * exitDrillMode, syncDrillState, ensureStrip — the page's own drill
 * script). ycLauncher is stubbed at its PUBLIC API only (isReady,
 * effectiveRegistry, elementsOf, exec) — exec keeps its real contract:
 * refuses ids outside the effective registry, picks the page by its routing
 * (opts.page, the active page, then the pages in order — the first that
 * shows a tile for the id; with none, the real exec opens the panel tab,
 * tests/launcherC1.test.js — this stub refuses), opens it through
 * window.openMainTab, then opens the panel there (or the dialog for an
 * action tile).
 *
 * The real-browser round trips (drill → URL → reload, roles, the All pill,
 * ?manual=) live in scripts/mobile-survey/wsurl.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const MODULE = fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let i = src.indexOf('{', m.index + m[0].length - 1);
  let paren = 0;
  for (let j = m.index + m[0].length - 1; j < src.length; j++) {
    if (src[j] === '(') paren++;
    else if (src[j] === ')' && --paren === 0) { i = src.indexOf('{', j); break; }
  }
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

function assignedFnSrc(src, name) {
  const i = src.indexOf(`window.${name} = function`);
  if (i < 0) throw new Error(`window.${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1) + ';';
  }
  throw new Error(`window.${name}: unbalanced`);
}

const pick = (re) => { const m = re.exec(SHELL); if (!m) throw new Error('not found: ' + re); return m[0]; };

// Tiles in a DIFFERENT order from the registry on purpose: mapping is by
// data-target, never by position. The panels sit on the stage (#ycPanels),
// after the pages, as in the real page. Every page tile is a neutral
// (data-yc-shortcut, + data-target for a panel — ycLauncher's neutral()); the
// element ids are the test's handles only. Users sits on More AND Admin.
const DOM = `<!DOCTYPE html><html><body>
  <div id="tabOpenFiles"></div>
  <div id="tabHome" class="tab-main" style="display:block"></div>
  <div id="tabCases" class="tab-main" style="display:none"></div>
  <div id="ycPages"><div id="ycPage-5" class="tab-main yc-hub" data-yc-page="firm:more" style="display:none"><h1>More Features</h1>
    <button class="big-button" id="tManuals" data-yc-shortcut="moreManuals" data-target="manualsDiv">Manuals</button>
    <button class="big-button" id="tAuto" data-yc-shortcut="moreAutomations" data-target="automationsDiv">Automations</button>
    <button class="big-button" id="tSettings" data-yc-shortcut="moreSettings">Settings</button>
    <button class="big-button" id="tStray" data-yc-shortcut="moreStray" data-target="strayDiv">Stray</button>
    <button class="big-button" data-yc-shortcut="adminUsers" data-target="usersDiv">Users</button>
    <div class="page-egg-row"></div></div><div id="ycPage-6" class="tab-main yc-hub" data-yc-page="firm:admin" style="display:none"><h1>Admin</h1>
    <button class="big-button" id="tDb" data-yc-shortcut="adminDbConsole" data-target="dbConsoleDiv">DB</button>
    <button class="big-button" id="tEtch" data-yc-shortcut="adminEtch">Etch</button>
    <button class="big-button" id="tUsers" data-yc-shortcut="adminUsers" data-target="usersDiv">Users</button>
    <div class="page-egg-row"></div></div><div id="ycPage-1" class="tab-main yc-hub" data-yc-page="firm:ops" style="display:none"><h1>Ops</h1><button class="big-button" data-yc-shortcut="moreAutomations" data-target="automationsDiv">Automations</button><button class="big-button" data-yc-shortcut="adminEtch">Etch</button><div class="page-egg-row"></div></div><div id="ycPage-2" class="tab-main yc-hub" data-yc-page="user:desk" style="display:none"><h1>Desk</h1><button class="big-button" data-yc-shortcut="moreManuals" data-target="manualsDiv">Manuals</button><div class="page-egg-row"></div></div></div>
  <div id="ycPanels" style="display:none">
    <div id="automationsDiv" style="display:none"><iframe id="autoFrame" data-src="/automationManager.html"></iframe><div><iframe id="deepFrame"></iframe></div></div>
    <div id="manualsDiv" style="display:none"><iframe id="manFrame" data-src="/manuals.html"></iframe></div>
    <div id="orphanDiv" style="display:none"><iframe id="orphanFrame"></iframe></div>
    <div id="dbConsoleDiv" style="display:none"><iframe id="dbFrame" data-src="/dbConsole.html"></iframe></div>
    <div id="usersDiv" style="display:none"><iframe id="usersFrame" data-src="/users.html"></iframe></div>
  </div>
  <div class="swal2-container"><iframe id="swalFrame"></iframe></div>
  <!-- a More page tile's panel that is NOT on the stage, and is visible (J6) -->
  <div id="strayDiv"><iframe id="strayFrame"></iframe></div>
</body></html>`;

// More Features and Admin: the firm pages firm:more / firm:admin (launcher-nits C4)
const MORE = 'ycPage-5', ADMIN = 'ycPage-6';

// Every window shell() opens is closed after its test: ~20 jsdom shells per
// run otherwise stay alive until the worker exits.
const OPEN = [];
afterEach(() => { while (OPEN.length) OPEN.pop().close(); });

function shell({ su = true, denied = [] } = {}) {
  const dom = new JSDOM(DOM, { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
  OPEN.push(dom.window);
  const w = dom.window;
  const d = w.document;
  w.eval(MODULE);
  w.__writes = [];
  w.history.replaceState = (s, t, url) => w.__writes.push(url);
  w.__calls = { openMainTab: [], exec: [], dialog: 0 };
  w.eval(`
    var E = (id) => document.getElementById(id);
    var Toast = { fire() {} };
    ${pick(/var _wsSyncEnabled = false;/)}
    ${pick(/var _wsSyncQueued = false;/)}
    ${fnSrc(SHELL, 'syncWorkspaceUrl')}
    ${fnSrc(SHELL, 'enableWorkspaceUrlSync')}
    ${fnSrc(SHELL, 'currentMainTabId')}
    ${pick(/const YC_LABEL_KEY = "ycFileLabels";/)}
    ${pick(/var wsMainRest = \{\};/)}
    ${pick(/var wsPanelRest = \{\};/)}
    ${pick(/var WS_DRILL_SURFACE = \{[^}]*\};/)}
    ${pick(/var WS_FIRM_PAGE_RE = [^;\n]*;/)}
    ${pick(/var WS_HUB_ALIAS = \{[^}]*\};/)}
    ${['wsFirmPageId', 'wsFirmPageTabs', 'wsDrillSurface', 'wsDrillPanels', 'wsPageTile', 'wsOpenPanel', 'wsTabRest', 'wsRestoreDrill', 'wsSetFileRest', 'wsFrameOwner',
      'wsOpenTarget', 'wsMainTabAllowed', 'currentOpenFilesUrl', 'openMainTabOnBoot'].map((n) => fnSrc(SHELL, n)).join('\n')}
    ${assignedFnSrc(SHELL, 'ycReportSubTab')}
    ${assignedFnSrc(SHELL, 'ycTakeSubTab')}
    // the panel stage, for real (the drill script; S6c-4)
    ${pick(/var drillMemory = \{\};/)}
    function hoverAnimClasses() { return []; }
    ${['stageShow', 'drillOpen', 'stageSync', 'ensureStrip', 'exitDrillMode', 'syncDrillState'].map((n) => fnSrc(SHELL, n)).join('\n')}
    ${pick(/document\.addEventListener\('click', \(e\) => \{\s*const btn = e\.target\.closest\('\[data-target\]'\);[\s\S]*?\n  \}\);/)}
    function openCasesTab() {} function openContactsTab() {} function openApptsTab() {}
    function openCalendarTab() {} function openEventsTab() {} function openLogsTab() {}
    function openMainTab(id) {
      __calls.openMainTab.push(id);
      if (currentMainTabId() === id) exitDrillMode(E(id));
      for (const t of document.querySelectorAll('.tab-main')) t.style.display = t.id === id ? 'block' : 'none';
      stageSync(id);   // what the real openMainTab does before its sync
      syncWorkspaceUrl();
    }
    window.__ws = { get main() { return wsMainRest; }, get panel() { return wsPanelRest; } };
  `);
  const $ = (id) => d.getElementById(id);
  // ycLauncher's public API, as the effective registry would answer it. No
  // item has a hub element any more (launcher-nits C4): elementsOf is {} for
  // all but a sidebar item; the page tiles are neutrals.
  if (!su) {   // firm:admin is not this user's page (visible_to): not built; Users isn't theirs either
    $(ADMIN).remove();
    d.querySelector(`#${MORE} > [data-yc-shortcut="adminUsers"]`).remove();
  }
  const EL = { newClient: { sidebar: d.createElement('a') } };   // not on any page at all
  // order = the effective registry's; 'firm:x' / 'firm:tile' are firm items (never a drill id);
  // moreStray's panel is NOT on the stage (J6); moreSettings and adminEtch are ACTION tiles
  const IDS = ['moreAutomations', 'moreManuals', 'moreSettings', 'newClient', 'firm:x', 'firm:tile', 'moreStray']
    .concat(su ? ['adminDbConsole', 'adminEtch', 'adminUsers'] : []);
  const effective = IDS.filter((id) => !denied.includes(id));
  w.ycLauncher = {
    isReady: () => true,
    effectiveRegistry: () => effective.map((id) => ({ id })),
    elementsOf: (id) => Object.assign({}, EL[id] || {}),
    exec: (id, opts) => {
      w.__calls.exec.push(opts && opts.page ? id + '@' + opts.page : id);
      if (!effective.includes(id)) return false;          // denied / firm-hidden / gated
      // the routing: opts.page, the active page, then the pages in order — the first that SHOWS a tile
      const pageTabs = Array.from(d.querySelectorAll('#ycPages > .tab-main')).map((e) => e.id);
      let at = null;
      for (const t of [opts && opts.page, w.currentMainTabId()].concat(pageTabs)) {
        if (!t || !$(t)) continue;
        const n = $(t).querySelector(`:scope > .big-button[data-yc-shortcut="${id}"]`);
        if (n) { at = { tab: t, el: n }; break; }
      }
      if (!at) return false;                               // (the real exec: the panel tab — launcherC1)
      w.openMainTab(at.tab);
      const target = at.el.getAttribute('data-target');
      if (!target) { w.__calls.dialog++; return true; }  // an action tile opens its dialog
      if (w.getComputedStyle($(target)).display !== 'none') return true;   // already up on this page
      w.drillOpen($(at.tab), target);                      // what the tile's click does
      return true;
    },
  };
  // syncWorkspaceUrl queues its replaceState with queueMicrotask (jsdom's is
  // Node's queue), so one awaited microtask lands it — no timer, no window
  // clock. Were the write ever moved onto a timer, these tests fail rather
  // than wait.
  const tick = () => Promise.resolve();
  const lastOpen = () => new w.URL(w.__writes[w.__writes.length - 1]).searchParams.get('open');
  // What a page remembers (a tile click on it), then the stage as the active
  // tab sees it: shown only while that page is the one on screen.
  const showPanel = (id, tab = MORE) => {
    if (id) w.drillMemory[tab] = id; else delete w.drillMemory[tab];
    w.stageSync(w.currentMainTabId());
  };
  return { w, $, tick, lastOpen, showPanel };
}

describe('wsurl S2 — the open panel → its registry id (by data-target)', () => {
  test('mapping by data-target, whatever the tile order; grid showing → no segment', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab(MORE);
    await tick();
    expect(lastOpen()).toBe('firm:more');
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels(MORE).map((p) => p.id)))).toEqual(['moreAutomations', 'moreManuals', 'adminUsers']);   // firm:tile skipped; the action tile has no panel; Users maps on both pages (S6c-4)
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels(ADMIN).map((p) => p.id)))).toEqual(['adminDbConsole', 'adminUsers']);
    showPanel('automationsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('firm:more~moreAutomations');
    showPanel('manualsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('firm:more~moreManuals');
    showPanel(null); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('firm:more');
    expect($('orphanDiv')).toBeTruthy();                   // a panel no effective item owns never maps
    $('orphanDiv').style.display = '';
    expect(w.wsTabRest(MORE)).toBe('');
  });

  test('a tile whose panel is NOT on the stage never maps (J6, restated for S6c-4)', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab(MORE);                              // the stage shows nothing
    await tick();
    expect(w.getComputedStyle($('strayDiv')).display).not.toBe('none');   // visible, and an effective item's target
    expect($('ycPanels').contains($('strayDiv'))).toBe(false);
    expect(w.wsOpenPanel(MORE)).toBeNull();
    expect(w.wsTabRest(MORE)).toBe('');
    expect(lastOpen()).toBe('firm:more');
    // its direct iframe is no More panel's pane either
    expect(w.wsFrameOwner($('strayFrame'))).toBeNull();
    w.ycReportSubTab($('strayFrame'), 'x');
    await tick();
    expect(w.__ws.panel).toEqual({});
    expect(lastOpen()).toBe('firm:more');
  });

  test('a denied item\'s open panel is not serialized (not in the effective registry)', () => {
    const { w, showPanel } = shell({ denied: ['moreAutomations'] });
    w.openMainTab(MORE);
    showPanel('automationsDiv');
    expect(w.wsTabRest(MORE)).toBe('');
  });

  test('syncDrillState and exitDrillMode both ask for a URL sync', () => {
    expect(fnSrc(SHELL, 'syncDrillState')).toMatch(/syncWorkspaceUrl\(\);\s*\/\/ the address bar's drill segment/);
    expect(fnSrc(SHELL, 'exitDrillMode')).toMatch(/syncWorkspaceUrl\(\);\s*\/\/ the address bar's drill segment/);
    // exitDrillMode, run for real: the panel closes, the page forgets it and the URL follows
    const { w, $, showPanel } = shell();
    w.openMainTab(MORE);
    showPanel('automationsDiv');
    let syncs = 0;
    w.syncWorkspaceUrl = () => { syncs++; };
    w.exitDrillMode($(MORE));
    expect($('automationsDiv').style.display).toBe('none');
    expect($('ycPanels').style.display).toBe('none');
    expect(w.drillMemory[MORE]).toBeUndefined();
    expect(syncs).toBe(1);
  });

  test('the same panel on two pages (S6c-4): each page names it by the same id; it is open on the page you are on, and only there', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab(MORE);
    w.document.querySelector('#' + MORE + ' > [data-yc-shortcut="adminUsers"]').click();   // the neutral: in place on More
    await tick();
    expect(lastOpen()).toBe('firm:more~adminUsers');
    expect([$(MORE).classList.contains('drill-active'), $(ADMIN).classList.contains('drill-active')]).toEqual([true, false]);
    expect($('usersFrame').getAttribute('src')).toBe('/users.html');   // loaded once, here
    // Admin shows its own grid: Users is not open THERE (per-page memory)
    w.openMainTab(ADMIN);
    await tick();
    expect(lastOpen()).toBe('firm:admin');
    expect(w.wsOpenPanel(ADMIN)).toBeNull();
    expect($('usersDiv').style.display).toBe('none');
    $('tUsers').click();                                   // the default tile: in place on Admin, the same element
    await tick();
    expect(lastOpen()).toBe('firm:admin~adminUsers');
    expect($('usersFrame').getAttribute('src')).toBe('/users.html');
    expect($('usersFrame').hasAttribute('data-src')).toBe(false);
    // back on More: what More had open (the same panel) — one stage panel at a time
    w.openMainTab(MORE);
    await tick();
    expect(lastOpen()).toBe('firm:more~adminUsers');
    expect([...$('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id)).toEqual(['usersDiv']);
  });
});

describe('wsurl S2 — restore (openMainTabOnBoot), every refusal lands on the grid', () => {
  test('a panel id reopens through exec, told the PAGE; the boot does NOT open the tab a second time', () => {
    const { w, $ } = shell();
    w.openMainTabOnBoot(MORE, 'moreAutomations');
    expect(w.__calls.exec).toEqual(['moreAutomations@' + MORE]);
    expect(w.__calls.openMainTab).toEqual([MORE]);   // exec's own, once
    expect($('automationsDiv').style.display).toBe('');
    expect($('autoFrame').getAttribute('src')).toBe('/automationManager.html');
    expect($(MORE).classList.contains('drill-active')).toBe(true);
  });

  test('a panel on two pages restores IN PLACE (S6c-4): firm:more~adminUsers reopens Users on More, firm:admin~adminUsers on Admin', async () => {
    const a = shell();
    a.w.enableWorkspaceUrlSync();
    a.w.openMainTabOnBoot(MORE, 'adminUsers~grants');
    await a.tick();
    expect(a.w.__calls.exec).toEqual(['adminUsers@' + MORE]);
    expect(a.w.__calls.openMainTab).toEqual([MORE]);
    expect([a.w.currentMainTabId(), a.$('usersDiv').style.display, a.$(ADMIN).classList.contains('drill-active')]).toEqual([MORE, '', false]);
    expect(a.w.ycTakeSubTab(a.$('usersFrame'))).toBe('grants');
    expect(a.lastOpen()).toBe('firm:more~adminUsers~grants');
    const b = shell();
    b.w.openMainTabOnBoot(ADMIN, 'adminUsers');
    expect(b.w.__calls.exec).toEqual(['adminUsers@' + ADMIN]);
    expect(b.w.__calls.openMainTab).toEqual([ADMIN]);
    expect([b.w.currentMainTabId(), b.$('usersDiv').style.display, b.$(MORE).classList.contains('drill-active')]).toEqual([ADMIN, '', false]);
    // a non-su: Users is not effective — the neutral is not drawn for them (the renderer's job, done in shell()); the restore refuses the id
    const c = shell({ su: false });
    c.w.openMainTabOnBoot(MORE, 'adminUsers');
    expect(c.w.__calls.exec).toEqual([]);
    expect(c.w.wsOpenPanel(MORE)).toBeNull();
  });

  test('a rest after the id is held for the panel\'s iframe, and shown in the URL', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTabOnBoot(MORE, 'moreAutomations~activity~42');
    expect(w.ycTakeSubTab($('autoFrame'))).toBe('activity~42');
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    await tick();
    expect(lastOpen()).toBe('firm:more~moreAutomations~activity~42');
  });

  test.each([
    ['firm:x', 'a firm item (":")'],
    ['firm:tile', 'a firm item even WITH a panel tile'],
    ['more:x', 'any ":"-bearing id'],
    ['moreSettings', 'an ACTION tile (no data-target — it switches tab)'],
    ['newClient', 'an id with no tile on this grid (wrong surface)'],
    ['adminDbConsole', 'an Admin id on More (no tile for it on this page)'],
    ['moreBogus', 'an unknown id'],
  ])('refused: %s — %s', (id) => {
    const { w, $ } = shell();
    w.openMainTabOnBoot(MORE, id + '~x');
    expect(w.__calls.exec).toEqual([]);                    // never even asked
    expect(w.__calls.dialog).toBe(0);
    expect(w.__calls.openMainTab).toEqual([MORE]);   // the grid
    expect(w.wsOpenPanel(MORE)).toBeNull();
    expect(w.__ws.panel).toEqual({});
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    expect(w.ycTakeSubTab($('usersFrame'))).toBeNull();
    expect($('manFrame').getAttribute('src')).toBeNull();          // nothing loaded
  });

  test('refused on Admin: adminEtch, an action tile that opens a DIALOG (SU)', () => {
    const { w } = shell({ su: true });
    w.openMainTabOnBoot(ADMIN, 'adminEtch');
    expect(w.__calls.exec).toEqual([]);
    expect(w.__calls.dialog).toBe(0);
    expect(w.__calls.openMainTab).toEqual([ADMIN]);
    expect(w.wsOpenPanel(ADMIN)).toBeNull();
  });

  test('exec refuses (a denied id): the grid, and nothing is left held', () => {
    const { w, $ } = shell({ denied: ['moreAutomations'] });
    w.openMainTabOnBoot(MORE, 'moreAutomations~activity');
    expect(w.__calls.exec).toEqual(['moreAutomations@' + MORE]);
    expect(w.__calls.openMainTab).toEqual([MORE]);
    expect($('automationsDiv').style.display).toBe('none');
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    expect(w.__ws.panel).toEqual({});
  });

  test('Admin as SU reopens; a tab with no rest just opens its grid', () => {
    const { w, $ } = shell({ su: true });
    w.openMainTabOnBoot(ADMIN, 'adminDbConsole');
    expect($('dbConsoleDiv').style.display).toBe('');
    const g = shell();
    g.w.openMainTabOnBoot(MORE, '');
    expect(g.w.__calls).toEqual({ openMainTab: [MORE], exec: [], dialog: 0 });
  });

  test('non-SU firm:admin~<id>: the HEAD fails first → Home (the Admin page is not theirs: not built); SU: allowed', () => {
    const { w } = shell({ su: false });
    expect(w.wsOpenTarget('firm:admin~adminDbConsole').tab).toBe('tabHome');
    expect(w.wsOpenTarget('firm:more~moreAutomations').tab).toBe(MORE);
    const su = shell({ su: true });
    expect(su.w.wsOpenTarget('firm:admin~adminDbConsole').tab).toBe(ADMIN);
  });
});

describe('wsurl S2 — a panel\'s pane frame (S4\'s automationManager) reports', () => {
  test('owner: the DIRECT iframe of an effective item\'s stage panel → { tab, panel }; else null', () => {
    const { w, $ } = shell({ denied: ['moreManuals'] });
    const own = (f) => JSON.parse(JSON.stringify(w.wsFrameOwner($(f))));
    expect(own('autoFrame')).toEqual({ tab: MORE, panel: 'moreAutomations' });
    expect(w.wsFrameOwner($('manFrame'))).toBeNull();      // its item is denied
    expect(w.wsFrameOwner($('deepFrame'))).toBeNull();     // nested in an EFFECTIVE panel, not its own
    expect(w.wsFrameOwner($('orphanFrame'))).toBeNull();   // on the stage, but no effective item's tile opens that div
    expect(w.wsFrameOwner($('swalFrame'))).toBeNull();
    expect(w.wsFrameOwner($('strayFrame'))).toBeNull();    // not on the stage (J6)
    // a panel two pages hold (S6c-4): the ACTIVE page when it has a tile for it, else the first drill page that has
    expect(own('usersFrame')).toEqual({ tab: MORE, panel: 'adminUsers' });   // on Home: More first
    w.openMainTab(ADMIN);
    expect(own('usersFrame')).toEqual({ tab: ADMIN, panel: 'adminUsers' });
    w.openMainTab(MORE);
    expect(own('usersFrame')).toEqual({ tab: MORE, panel: 'adminUsers' });
    expect(own('dbFrame')).toEqual({ tab: ADMIN, panel: 'adminDbConsole' });   // More has no tile for it
  });

  test('shown only while that panel is the open one in the ACTIVE tab; stored otherwise', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    w.__writes.length = 0;
    // More not active: stored, not shown
    w.ycReportSubTab($('autoFrame'), 'workflows');
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect(w.__ws.panel).toEqual({ moreAutomations: 'workflows' });
    // active tab, but ANOTHER panel open: still not shown
    w.openMainTab(MORE);
    showPanel('manualsDiv');
    await tick();                                          // openMainTab's own sync lands first
    w.__writes.length = 0;
    w.ycReportSubTab($('autoFrame'), 'activity');
    await tick();
    expect(w.__writes).toHaveLength(0);
    // its panel opens: the stored rest rides along
    showPanel('automationsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('firm:more~moreAutomations~activity');
    // and now a report is shown at once
    w.ycReportSubTab($('autoFrame'), 'triggers');
    await tick();
    expect(lastOpen()).toBe('firm:more~moreAutomations~triggers');
    w.ycReportSubTab($('autoFrame'), '');
    await tick();
    expect(lastOpen()).toBe('firm:more~moreAutomations');
  });

  test('a panel rest that would push id~rest over the caps is ignored', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab(MORE);
    showPanel('automationsDiv');
    w.ycReportSubTab($('autoFrame'), 'a~b~c~d');            // 5 segments with the id
    w.ycReportSubTab($('autoFrame'), 'x"><b>');
    await tick();
    expect(w.__ws.panel).toEqual({});
    expect(lastOpen()).toBe('firm:more~moreAutomations');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher-nits L4a (Fred, 2026-10-28): a FIRM page is a drill page the URL
// names by its firm item id — ?open=firm:<slug>[~panel~rest] — so F5, the
// update reload and a link come back to it (More and Admin become firm pages
// next, L4b). A user's OWN page is never named: its id is made from the
// name the user typed, and the URL rides Referer into jwt_api_audit_log
// (ruling Q4 stands for it). ycPage-1 = firm:ops (Automations, and an action
// tile), ycPage-2 = user:desk (Manuals).
describe('launcher-nits L4a — a firm page in the address bar', () => {
  test.each([
    ['firm:ops', { tab: 'ycPage-1', rest: '' }],
    ['firm:ops~moreAutomations~workflows~27', { tab: 'ycPage-1', rest: 'moreAutomations~workflows~27' }],
    ['firm:ops~x"><b>', { tab: 'ycPage-1', rest: '' }],            // an invalid rest is dropped, the page kept
    ['firm:gone', { tab: 'tabHome', rest: '' }],                    // no such page built (not effective here)
    ['user:desk', { tab: 'tabHome', rest: '' }],                    // a user's own page: never a head
    ['ycPage-1', { tab: 'tabHome', rest: '' }],                     // nor any page by its tab id
    ['ycPage-2~moreManuals', { tab: 'tabHome', rest: '' }],
    ['FIRM:ops', { tab: 'tabHome', rest: '' }],
    ['firm:ops"', { tab: 'tabHome', rest: '' }],
  ])('?open=%s → %j', (open, want) => {
    const { w } = shell();
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget(open)))).toEqual(want);
  });

  test('written: on a firm page the head is its item id, with its open panel and that panel\'s rest; on a user page there is no open= at all', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('ycPage-1');
    await tick();
    expect(lastOpen()).toBe('firm:ops');
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels('ycPage-1').map((p) => p.id)))).toEqual(['moreAutomations']);   // the action tile has no panel
    showPanel('automationsDiv', 'ycPage-1'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('firm:ops~moreAutomations');
    expect(JSON.parse(JSON.stringify(w.wsFrameOwner($('autoFrame'))))).toEqual({ tab: 'ycPage-1', panel: 'moreAutomations' });
    w.ycReportSubTab($('autoFrame'), 'workflows~27');
    await tick();
    expect(lastOpen()).toBe('firm:ops~moreAutomations~workflows~27');
    // a user page: nothing names it, open or not
    w.openMainTab('ycPage-2');
    showPanel('manualsDiv', 'ycPage-2'); w.syncWorkspaceUrl(); await tick();
    expect(w.currentMainTabId()).toBe('ycPage-2');
    expect(lastOpen()).toBe(null);
    expect(w.wsDrillSurface('ycPage-2')).toBe(null);
  });

  test('a firm page\'s panel that reports while another tab is active is remembered, and shown when the page is back', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    $('tAuto').remove();                                                                  // More doesn't show it: only firm:ops does
    w.openMainTab('ycPage-1');
    showPanel('automationsDiv', 'ycPage-1');
    w.openMainTab('tabCases');
    await tick();
    expect(JSON.parse(JSON.stringify(w.wsFrameOwner($('autoFrame'))))).toEqual({ tab: 'ycPage-1', panel: 'moreAutomations' });
    w.ycReportSubTab($('autoFrame'), 'activity~42');
    await tick();
    expect(lastOpen()).toBe('tabCases');
    expect(w.__ws.panel).toEqual({ moreAutomations: 'activity~42' });
    w.openMainTab('ycPage-1');
    await tick();
    expect(lastOpen()).toBe('firm:ops~moreAutomations~activity~42');
  });

  test('restored: firm:ops~moreAutomations~workflows~27 reopens Automations ON that page (exec told the page), its rest held for the pane', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    const at = w.wsOpenTarget('firm:ops~moreAutomations~workflows~27');
    w.openMainTabOnBoot(at.tab, at.rest);
    expect(w.__calls.exec).toEqual(['moreAutomations@ycPage-1']);
    expect(w.currentMainTabId()).toBe('ycPage-1');
    expect($('automationsDiv').style.display).toBe('');
    expect($('ycPage-1').classList.contains('drill-active')).toBe(true);
    expect(w.ycTakeSubTab($('autoFrame'))).toBe('workflows~27');
    await tick();
    expect(lastOpen()).toBe('firm:ops~moreAutomations~workflows~27');   // the round trip
  });

  test.each([
    ['moreManuals', 'a panel this page has no tile for'],
    ['adminEtch', 'an ACTION tile on the page (no data-target)'],
    ['firm:x', 'a firm item'],
  ])('restore refused on a firm page: %s — %s → the page\'s own grid', (id) => {
    const { w, $ } = shell();
    w.openMainTabOnBoot('ycPage-1', id + '~x');
    expect(w.__calls.exec).toEqual([]);
    expect(w.__calls.openMainTab).toEqual(['ycPage-1']);
    expect(w.wsOpenPanel('ycPage-1')).toBeNull();
    expect(w.ycTakeSubTab($('manFrame'))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher-nits C1: the PANEL TAB (a panel no page shows) in the address
// bar — ?open=tabPanel~<id>[~rest]. Its one tile is the panel it hosts, so
// the write side is the pages' own; the restore asks exec (no opts.page:
// exec routes the panel — a page that shows it, else the panel tab).
describe('launcher-nits C1 — the panel tab in the address bar', () => {
  const host = (w, id, target) => {
    const el = w.document.createElement('div');
    el.id = 'tabPanel'; el.className = 'tab-main yc-hub'; el.style.display = 'none';
    el.innerHTML = `<h1>X</h1><button class="big-button" data-yc-shortcut="${id}" data-target="${target}">X</button>`;
    w.document.getElementById('ycPages').before(el);
    return el;
  };

  test.each([
    ['tabPanel', { tab: 'tabHome', rest: '' }],                      // nothing hosted: Home
    ['tabPanel~moreAutomations', { tab: 'tabPanel', rest: 'moreAutomations' }],
    ['tabPanel~moreAutomations~workflows~27', { tab: 'tabPanel', rest: 'moreAutomations~workflows~27' }],
    ['tabPanel~x"><b>', { tab: 'tabHome', rest: '' }],               // an invalid rest: nothing to host
  ])('?open=%s → %j', (open, want) => {
    const { w } = shell();
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget(open)))).toEqual(want);
  });

  test('written: the hosted panel and its pane\'s rest ride as tabPanel~<id>~<rest>', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    host(w, 'moreAutomations', 'automationsDiv');
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabPanel');
    showPanel('automationsDiv', 'tabPanel'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('tabPanel~moreAutomations');
    expect(JSON.parse(JSON.stringify(w.wsFrameOwner($('autoFrame'))))).toEqual({ tab: 'tabPanel', panel: 'moreAutomations' });
    w.ycReportSubTab($('autoFrame'), 'workflows~27');
    await tick();
    expect(lastOpen()).toBe('tabPanel~moreAutomations~workflows~27');
  });

  test('restored through exec (no page named: exec routes it), its rest held for the pane; refused → Home, nothing held', () => {
    const { w, $ } = shell();
    w.FEATURE_REGISTRY = { moreAutomations: { target: 'automationsDiv' }, moreManuals: { target: 'manualsDiv' } };
    w.openMainTabOnBoot('tabPanel', 'moreAutomations~workflows~27');
    expect(w.__calls.exec).toEqual(['moreAutomations']);
    expect(w.ycTakeSubTab($('autoFrame'))).toBe('workflows~27');
    w.__calls.exec.length = 0; w.__calls.openMainTab.length = 0;
    w.openMainTabOnBoot('tabPanel', 'adminBogus~x');                  // no such panel: never asked
    expect([w.__calls.exec, w.__calls.openMainTab]).toEqual([[], ['tabHome']]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// launcher-nits C2 / C4: the hubs are gone, so an old ?open=tabMore… /
// tabAdmin… is an ALIAS — the firm page that replaced the hub (firm:more /
// firm:admin), else, with its panel named, the panel tab (exec routes it).
describe('launcher-nits C2 — tabMore / tabAdmin as aliases (the hubs are gone, C4)', () => {
  test('firm:more / firm:admin built: an old tabMore… / tabAdmin… opens them, with the rest', () => {
    const { w } = shell();
    expect(w.document.getElementById('tabMore')).toBe(null);
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabMore~moreAutomations~workflows~27')))).toEqual({ tab: MORE, rest: 'moreAutomations~workflows~27' });
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabMore')))).toEqual({ tab: MORE, rest: '' });
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabAdmin~adminUsers')))).toEqual({ tab: ADMIN, rest: 'adminUsers' });
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabAdmin')))).toEqual({ tab: ADMIN, rest: '' });
  });

  test('firm:admin not this user\'s (not built): tabAdmin~<panel> → the panel tab (exec refuses what isn\'t theirs), tabAdmin alone → Home', () => {
    const { w } = shell({ su: false });
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabAdmin~adminUsers')))).toEqual({ tab: 'tabPanel', rest: 'adminUsers' });
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget('tabAdmin')))).toEqual({ tab: 'tabHome', rest: '' });
  });

  test('no firm:more page (the firm deleted it): tabMore~<panel> → the panel tab; restored through exec', () => {
    const { w, $ } = shell();
    $(MORE).remove();
    w.FEATURE_REGISTRY = { moreAutomations: { target: 'automationsDiv' } };
    const at = w.wsOpenTarget('tabMore~moreAutomations~workflows~27');
    expect(JSON.parse(JSON.stringify(at))).toEqual({ tab: 'tabPanel', rest: 'moreAutomations~workflows~27' });
    w.openMainTabOnBoot(at.tab, at.rest);
    expect(w.__calls.exec).toEqual(['moreAutomations']);
    expect(w.ycTakeSubTab($('autoFrame'))).toBe('workflows~27');
  });
});
