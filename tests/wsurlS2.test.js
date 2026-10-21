/**
 * wsurl S2 — the workspace URL remembers the open More / Admin drill panel.
 *
 *   ?open=tabMore~<registryId>[~<pane rest>]   tabAdmin~<registryId>[~…]
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
 * refuses ids outside the effective registry, picks the page by the S6c-4
 * routing (opts.page, the active page, More, Admin — the first that shows a
 * tile for the id; else the hidden default), opens it through
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
// after the pages, as in the real page; tUsersOnMore is a neutral the firm
// placed on More for the Admin panel Users (data-yc-shortcut + data-target,
// no id, no group — ycLauncher's neutral()).
const DOM = `<!DOCTYPE html><html><body>
  <div id="tabOpenFiles"></div>
  <div id="tabHome" class="tab-main" style="display:block"></div>
  <div id="tabCases" class="tab-main" style="display:none"></div>
  <div id="tabMore" class="tab-main" style="display:none">
    <button class="big-button" id="tManuals" data-target="manualsDiv" data-exclusive-group="more">Manuals</button>
    <button class="big-button" id="tAuto" data-target="automationsDiv" data-exclusive-group="more">Automations</button>
    <button class="big-button" id="tSettings" onclick="openMainTab('tabSettings')">Settings</button>
    <button class="big-button" id="tStray" data-target="strayDiv" data-exclusive-group="more">Stray</button>
    <button class="big-button" id="tUnplaced" data-target="unplacedDiv" data-exclusive-group="more" data-yc-unplaced="">Unplaced</button>
    <button class="big-button" data-yc-shortcut="adminUsers" data-target="usersDiv">Users</button>
  </div>
  <div id="tabAdmin" class="tab-main" style="display:none">
    <button class="big-button" id="tDb" data-target="dbConsoleDiv" data-exclusive-group="admin">DB</button>
    <button class="big-button" id="tEtch" onclick="etchSwal()">Etch</button>
    <button class="big-button" id="tUsers" data-target="usersDiv" data-exclusive-group="admin">Users</button>
  </div>
  <div id="ycPanels" style="display:none">
    <div id="unplacedDiv" style="display:none"><iframe id="unplacedFrame" data-src="/unplaced.html"></iframe></div>
    <div id="automationsDiv" style="display:none"><iframe id="autoFrame" data-src="/automationManager.html"></iframe><div><iframe id="deepFrame"></iframe></div></div>
    <div id="manualsDiv" style="display:none"><iframe id="manFrame" data-src="/manuals.html"></iframe></div>
    <div id="orphanDiv" style="display:none"><iframe id="orphanFrame"></iframe></div>
    <div id="dbConsoleDiv" style="display:none"><iframe id="dbFrame" data-src="/dbConsole.html"></iframe></div>
    <div id="usersDiv" style="display:none"><iframe id="usersFrame" data-src="/users.html"></iframe></div>
  </div>
  <div class="swal2-container"><iframe id="swalFrame"></iframe></div>
  <!-- a More tile's panel that is NOT on the stage, and is visible (J6) -->
  <div id="strayDiv"><iframe id="strayFrame"></iframe></div>
</body></html>`;

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
    ${['wsDrillPanels', 'wsPageTile', 'wsOpenPanel', 'wsTabRest', 'wsRestoreDrill', 'wsSetFileRest', 'wsFrameOwner',
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
  // ycLauncher's public API, as the effective registry would answer it.
  const EL = {
    moreAutomations: { more: $('tAuto') },
    moreManuals: { more: $('tManuals') },
    moreSettings: { more: $('tSettings') },               // an ACTION tile: no data-target (it switches tab)
    newClient: { sidebar: d.createElement('a') },        // not on the More grid at all
    'firm:x': {},
    // A firm item WITH a panel tile (ui-custom S3.3 adds a firm row to the
    // More grid): still never restored from a URL — refusal (a) on its own.
    'firm:tile': { more: $('tManuals') },
    moreStray: { more: $('tStray') },                     // its panel is NOT inside tabMore (J6)
    // A tile the firm's layout took off this grid (ui-custom S6c): in the DOM, hidden by
    // data-yc-unplaced, still an effective item — the restore refuses it, the grid shows.
    moreUnplaced: { more: $('tUnplaced') },
  };
  if (su) EL.adminDbConsole = { admin: $('tDb') };
  if (su) EL.admin = { sidebar: d.createElement('a') };  // the Admin PAGE item (S6c: the URL door to tabAdmin)
  EL.moreFeatures = { sidebar: d.createElement('a') };    // the More page item
  if (su) EL.adminEtch = { admin: $('tEtch') };           // an ACTION tile that opens a DIALOG
  // Users: its default tile is Admin's; the firm ALSO placed it on More as a
  // neutral (S6c-4) — the same panel, opened in place from either page
  if (su) EL.adminUsers = { admin: $('tUsers') };
  const effective = Object.keys(EL).filter((id) => !denied.includes(id));
  const TAB = { more: 'tabMore', admin: 'tabAdmin' };
  w.ycLauncher = {
    isReady: () => true,
    effectiveRegistry: () => effective.map((id) => ({ id })),
    elementsOf: (id) => Object.assign({}, EL[id] || {}),   // returns hidden (denied) elements too
    exec: (id, opts) => {
      w.__calls.exec.push(opts && opts.page ? id + '@' + opts.page : id);
      if (!effective.includes(id)) return false;          // denied / firm-hidden / admin-gated
      const m = EL[id];
      const sf = m.more ? 'more' : m.admin ? 'admin' : null;
      if (!sf) return false;
      // the S6c-4 routing: the first page that SHOWS a tile for the id
      const home = TAB[sf], def = m[sf];
      let at = null;
      for (const t of [opts && opts.page, w.currentMainTabId(), 'tabMore', 'tabAdmin']) {
        if (!t || !$(t)) continue;
        if (t === home && !def.hasAttribute('data-yc-unplaced')) { at = { tab: t, el: def }; break; }
        const n = $(t).querySelector(`:scope > .big-button[data-yc-shortcut="${id}"][data-target]`);
        if (n) { at = { tab: t, el: n }; break; }
      }
      if (!at) at = { tab: home, el: def };
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
  const showPanel = (id, tab = 'tabMore') => {
    if (id) w.drillMemory[tab] = id; else delete w.drillMemory[tab];
    w.stageSync(w.currentMainTabId());
  };
  return { w, $, tick, lastOpen, showPanel };
}

describe('wsurl S2 — the open panel → its registry id (by data-target)', () => {
  test('mapping by data-target, whatever the tile order; grid showing → no segment', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabMore');
    await tick();
    expect(lastOpen()).toBe('tabMore');
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels('tabMore').map((p) => p.id)))).toEqual(['moreAutomations', 'moreManuals', 'moreUnplaced', 'adminUsers']);   // firm:tile skipped; an unplaced tile still maps (only the restore refuses it); the firm-placed neutral maps (S6c-4)
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels('tabAdmin').map((p) => p.id)))).toEqual(['adminDbConsole', 'adminUsers']);
    showPanel('automationsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('tabMore~moreAutomations');
    showPanel('manualsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('tabMore~moreManuals');
    showPanel(null); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('tabMore');
    expect($('orphanDiv')).toBeTruthy();                   // a panel no effective item owns never maps
    $('orphanDiv').style.display = '';
    expect(w.wsTabRest('tabMore')).toBe('');
  });

  test('a tile whose panel is NOT on the stage never maps (J6, restated for S6c-4)', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabMore');                              // the stage shows nothing
    await tick();
    expect(w.getComputedStyle($('strayDiv')).display).not.toBe('none');   // visible, and an effective item's target
    expect($('ycPanels').contains($('strayDiv'))).toBe(false);
    expect(w.wsOpenPanel('tabMore')).toBeNull();
    expect(w.wsTabRest('tabMore')).toBe('');
    expect(lastOpen()).toBe('tabMore');
    // its direct iframe is no tabMore panel's pane either
    expect(w.wsFrameOwner($('strayFrame'))).toBeNull();
    w.ycReportSubTab($('strayFrame'), 'x');
    await tick();
    expect(w.__ws.panel).toEqual({});
    expect(lastOpen()).toBe('tabMore');
  });

  test('a denied item\'s open panel is not serialized (not in the effective registry)', () => {
    const { w, showPanel } = shell({ denied: ['moreAutomations'] });
    w.openMainTab('tabMore');
    showPanel('automationsDiv');
    expect(w.wsTabRest('tabMore')).toBe('');
  });

  test('syncDrillState and exitDrillMode both ask for a URL sync', () => {
    expect(fnSrc(SHELL, 'syncDrillState')).toMatch(/syncWorkspaceUrl\(\);\s*\/\/ the address bar's drill segment/);
    expect(fnSrc(SHELL, 'exitDrillMode')).toMatch(/syncWorkspaceUrl\(\);\s*\/\/ the address bar's drill segment/);
    // exitDrillMode, run for real: the panel closes, the page forgets it and the URL follows
    const { w, $, showPanel } = shell();
    w.openMainTab('tabMore');
    showPanel('automationsDiv');
    let syncs = 0;
    w.syncWorkspaceUrl = () => { syncs++; };
    w.exitDrillMode($('tabMore'));
    expect($('automationsDiv').style.display).toBe('none');
    expect($('ycPanels').style.display).toBe('none');
    expect(w.drillMemory.tabMore).toBeUndefined();
    expect(syncs).toBe(1);
  });

  test('the same panel on two pages (S6c-4): each page names it by the same id; it is open on the page you are on, and only there', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabMore');
    w.document.querySelector('#tabMore > [data-yc-shortcut="adminUsers"]').click();   // the neutral: in place on More
    await tick();
    expect(lastOpen()).toBe('tabMore~adminUsers');
    expect([$('tabMore').classList.contains('drill-active'), $('tabAdmin').classList.contains('drill-active')]).toEqual([true, false]);
    expect($('usersFrame').getAttribute('src')).toBe('/users.html');   // loaded once, here
    // Admin shows its own grid: Users is not open THERE (per-page memory)
    w.openMainTab('tabAdmin');
    await tick();
    expect(lastOpen()).toBe('tabAdmin');
    expect(w.wsOpenPanel('tabAdmin')).toBeNull();
    expect($('usersDiv').style.display).toBe('none');
    $('tUsers').click();                                   // the default tile: in place on Admin, the same element
    await tick();
    expect(lastOpen()).toBe('tabAdmin~adminUsers');
    expect($('usersFrame').getAttribute('src')).toBe('/users.html');
    expect($('usersFrame').hasAttribute('data-src')).toBe(false);
    // back on More: what More had open (the same panel) — one stage panel at a time
    w.openMainTab('tabMore');
    await tick();
    expect(lastOpen()).toBe('tabMore~adminUsers');
    expect([...$('ycPanels').children].filter((p) => p.style.display !== 'none').map((p) => p.id)).toEqual(['usersDiv']);
  });
});

describe('wsurl S2 — restore (openMainTabOnBoot), every refusal lands on the grid', () => {
  test('a panel id reopens through exec, told the PAGE; the boot does NOT open the tab a second time', () => {
    const { w, $ } = shell();
    w.openMainTabOnBoot('tabMore', 'moreAutomations');
    expect(w.__calls.exec).toEqual(['moreAutomations@tabMore']);
    expect(w.__calls.openMainTab).toEqual(['tabMore']);   // exec's own, once
    expect($('automationsDiv').style.display).toBe('');
    expect($('autoFrame').getAttribute('src')).toBe('/automationManager.html');
    expect($('tabMore').classList.contains('drill-active')).toBe(true);
  });

  test('a firm-placed neutral restores IN PLACE (S6c-4): tabMore~adminUsers reopens Users on More, tabAdmin~adminUsers on Admin', async () => {
    const a = shell();
    a.w.enableWorkspaceUrlSync();
    a.w.openMainTabOnBoot('tabMore', 'adminUsers~grants');
    await a.tick();
    expect(a.w.__calls.exec).toEqual(['adminUsers@tabMore']);
    expect(a.w.__calls.openMainTab).toEqual(['tabMore']);
    expect([a.w.currentMainTabId(), a.$('usersDiv').style.display, a.$('tabAdmin').classList.contains('drill-active')]).toEqual(['tabMore', '', false]);
    expect(a.w.ycTakeSubTab(a.$('usersFrame'))).toBe('grants');
    expect(a.lastOpen()).toBe('tabMore~adminUsers~grants');
    const b = shell();
    b.w.openMainTabOnBoot('tabAdmin', 'adminUsers');
    expect(b.w.__calls.exec).toEqual(['adminUsers@tabAdmin']);
    expect(b.w.__calls.openMainTab).toEqual(['tabAdmin']);
    expect([b.w.currentMainTabId(), b.$('usersDiv').style.display, b.$('tabMore').classList.contains('drill-active')]).toEqual(['tabAdmin', '', false]);
    // a non-su: Users is not effective — the neutral is not drawn for them (the renderer's job); the restore refuses the id
    const c = shell({ su: false });
    c.w.document.querySelector('#tabMore > [data-yc-shortcut="adminUsers"]').remove();
    c.w.openMainTabOnBoot('tabMore', 'adminUsers');
    expect(c.w.__calls.exec).toEqual([]);
    expect(c.w.wsOpenPanel('tabMore')).toBeNull();
  });

  test('a rest after the id is held for the panel\'s iframe, and shown in the URL', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTabOnBoot('tabMore', 'moreAutomations~activity~42');
    expect(w.ycTakeSubTab($('autoFrame'))).toBe('activity~42');
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    await tick();
    expect(lastOpen()).toBe('tabMore~moreAutomations~activity~42');
  });

  test.each([
    ['firm:x', 'a firm item (":")'],
    ['firm:tile', 'a firm item even WITH a panel tile'],
    ['more:x', 'any ":"-bearing id'],
    ['moreSettings', 'an ACTION tile (no data-target — it switches tab)'],
    ['newClient', 'an id with no tile on this grid (wrong surface)'],
    ['adminDbConsole', 'an Admin id on tabMore (wrong surface)'],
    ['moreBogus', 'an unknown id'],
    ['moreUnplaced', 'a tile the firm\'s layout took off this grid (data-yc-unplaced, ui-custom S6c) — its panel would open with no pill lit'],
  ])('refused: %s — %s', (id) => {
    const { w, $ } = shell();
    w.openMainTabOnBoot('tabMore', id + '~x');
    expect(w.__calls.exec).toEqual([]);                    // never even asked
    expect(w.__calls.dialog).toBe(0);
    expect(w.__calls.openMainTab).toEqual(['tabMore']);   // the grid
    expect(w.wsOpenPanel('tabMore')).toBeNull();
    expect(w.__ws.panel).toEqual({});
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    expect(w.ycTakeSubTab($('unplacedFrame'))).toBeNull();
    expect($('unplacedFrame').getAttribute('src')).toBeNull();   // never loaded
  });

  test('refused on tabAdmin: adminEtch, an action tile that opens a DIALOG (SU)', () => {
    const { w } = shell({ su: true });
    w.openMainTabOnBoot('tabAdmin', 'adminEtch');
    expect(w.__calls.exec).toEqual([]);
    expect(w.__calls.dialog).toBe(0);
    expect(w.__calls.openMainTab).toEqual(['tabAdmin']);
    expect(w.wsOpenPanel('tabAdmin')).toBeNull();
  });

  test('exec refuses (a denied id): the grid, and nothing is left held', () => {
    const { w, $ } = shell({ denied: ['moreAutomations'] });
    w.openMainTabOnBoot('tabMore', 'moreAutomations~activity');
    expect(w.__calls.exec).toEqual(['moreAutomations@tabMore']);
    expect(w.__calls.openMainTab).toEqual(['tabMore']);
    expect($('automationsDiv').style.display).toBe('none');
    expect(w.ycTakeSubTab($('autoFrame'))).toBeNull();
    expect(w.__ws.panel).toEqual({});
  });

  test('Admin as SU reopens; a tab with no rest just opens its grid', () => {
    const { w, $ } = shell({ su: true });
    w.openMainTabOnBoot('tabAdmin', 'adminDbConsole');
    expect($('dbConsoleDiv').style.display).toBe('');
    const g = shell();
    g.w.openMainTabOnBoot('tabMore', '');
    expect(g.w.__calls).toEqual({ openMainTab: ['tabMore'], exec: [], dialog: 0 });
  });

  test('non-SU tabAdmin~<id>: the HEAD fails first → Home (the Admin page item is not effective); SU: allowed', () => {
    const { w } = shell({ su: false });
    expect(w.wsOpenTarget('tabAdmin~adminDbConsole').tab).toBe('tabHome');
    expect(w.wsOpenTarget('tabMore~moreAutomations').tab).toBe('tabMore');
    const su = shell({ su: true });
    expect(su.w.wsOpenTarget('tabAdmin~adminDbConsole').tab).toBe('tabAdmin');
  });
});

describe('wsurl S2 — a panel\'s pane frame (S4\'s automationManager) reports', () => {
  test('owner: the DIRECT iframe of an effective item\'s stage panel → { tab, panel }; else null', () => {
    const { w, $ } = shell({ denied: ['moreManuals'] });
    const own = (f) => JSON.parse(JSON.stringify(w.wsFrameOwner($(f))));
    expect(own('autoFrame')).toEqual({ tab: 'tabMore', panel: 'moreAutomations' });
    expect(w.wsFrameOwner($('manFrame'))).toBeNull();      // its item is denied
    expect(w.wsFrameOwner($('deepFrame'))).toBeNull();     // nested in an EFFECTIVE panel, not its own
    expect(w.wsFrameOwner($('orphanFrame'))).toBeNull();   // on the stage, but no effective item's tile opens that div
    expect(w.wsFrameOwner($('swalFrame'))).toBeNull();
    expect(w.wsFrameOwner($('strayFrame'))).toBeNull();    // not on the stage (J6)
    // a panel two pages hold (S6c-4): the ACTIVE page when it has a tile for it, else the first drill page that has
    expect(own('usersFrame')).toEqual({ tab: 'tabMore', panel: 'adminUsers' });   // on Home: More first
    w.openMainTab('tabAdmin');
    expect(own('usersFrame')).toEqual({ tab: 'tabAdmin', panel: 'adminUsers' });
    w.openMainTab('tabMore');
    expect(own('usersFrame')).toEqual({ tab: 'tabMore', panel: 'adminUsers' });
    expect(own('dbFrame')).toEqual({ tab: 'tabAdmin', panel: 'adminDbConsole' });   // More has no tile for it
  });

  test('shown only while that panel is the open one in the ACTIVE tab; stored otherwise', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    w.__writes.length = 0;
    // tabMore not active: stored, not shown
    w.ycReportSubTab($('autoFrame'), 'workflows');
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect(w.__ws.panel).toEqual({ moreAutomations: 'workflows' });
    // active tab, but ANOTHER panel open: still not shown
    w.openMainTab('tabMore');
    showPanel('manualsDiv');
    await tick();                                          // openMainTab's own sync lands first
    w.__writes.length = 0;
    w.ycReportSubTab($('autoFrame'), 'activity');
    await tick();
    expect(w.__writes).toHaveLength(0);
    // its panel opens: the stored rest rides along
    showPanel('automationsDiv'); w.syncWorkspaceUrl(); await tick();
    expect(lastOpen()).toBe('tabMore~moreAutomations~activity');
    // and now a report is shown at once
    w.ycReportSubTab($('autoFrame'), 'triggers');
    await tick();
    expect(lastOpen()).toBe('tabMore~moreAutomations~triggers');
    w.ycReportSubTab($('autoFrame'), '');
    await tick();
    expect(lastOpen()).toBe('tabMore~moreAutomations');
  });

  test('a panel rest that would push id~rest over the caps is ignored', async () => {
    const { w, $, tick, lastOpen, showPanel } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabMore');
    showPanel('automationsDiv');
    w.ycReportSubTab($('autoFrame'), 'a~b~c~d');            // 5 segments with the id
    w.ycReportSubTab($('autoFrame'), 'x"><b>');
    await tick();
    expect(w.__ws.panel).toEqual({});
    expect(lastOpen()).toBe('tabMore~moreAutomations');
  });
});
