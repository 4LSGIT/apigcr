/**
 * wsurl S2 — the workspace URL remembers the open More / Admin drill panel.
 *
 *   ?open=tabMore~<registryId>[~<pane rest>]   tabAdmin~<registryId>[~…]
 *
 * The REAL shell functions, extracted from public/index.html (the fnSrc
 * pattern of tests/unifiedEventsU9.shell.test.js), run over a DOM shaped
 * like the More / Admin grids: tiles carrying data-target, their panels,
 * the panels' lazy iframes, plus an action tile (a dialog) and a frame in a
 * Swal. ycLauncher is stubbed at its PUBLIC API only (isReady,
 * effectiveRegistry, elementsOf, exec) — exec keeps its real contract:
 * refuses ids outside the effective registry, opens the item's tab through
 * window.openMainTab, then shows the panel (or opens the dialog for an
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
// data-target, never by position.
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
    <div id="unplacedDiv" style="display:none"><iframe id="unplacedFrame" data-src="/unplaced.html"></iframe></div>
    <div id="automationsDiv" style="display:none"><iframe id="autoFrame" data-src="/automationManager.html"></iframe><div><iframe id="deepFrame"></iframe></div></div>
    <div id="manualsDiv" style="display:none"><iframe id="manFrame" data-src="/manuals.html"></iframe></div>
    <div id="orphanDiv" style="display:none"><iframe id="orphanFrame"></iframe></div>
  </div>
  <div id="tabAdmin" class="tab-main" style="display:none">
    <button class="big-button" id="tDb" data-target="dbConsoleDiv" data-exclusive-group="admin">DB</button>
    <button class="big-button" id="tEtch" onclick="etchSwal()">Etch</button>
    <div id="dbConsoleDiv" style="display:none"><iframe id="dbFrame" data-src="/dbConsole.html"></iframe></div>
  </div>
  <div class="swal2-container"><iframe id="swalFrame"></iframe></div>
  <!-- a More tile's panel that lives OUTSIDE tabMore, and is visible -->
  <div id="strayDiv"><iframe id="strayFrame"></iframe></div>
</body></html>`;

function shell({ su = true, denied = [] } = {}) {
  const dom = new JSDOM(DOM, { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
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
    ${['wsDrillPanels', 'wsOpenPanel', 'wsTabRest', 'wsRestoreDrill', 'wsSetFileRest', 'wsFrameOwner',
      'wsOpenTarget', 'wsMainTabAllowed', 'currentOpenFilesUrl', 'openMainTabOnBoot'].map((n) => fnSrc(SHELL, n)).join('\n')}
    ${assignedFnSrc(SHELL, 'ycReportSubTab')}
    ${assignedFnSrc(SHELL, 'ycTakeSubTab')}
    function openCasesTab() {} function openContactsTab() {} function openApptsTab() {}
    function openCalendarTab() {} function openEventsTab() {} function openLogsTab() {}
    function openMainTab(id) {
      __calls.openMainTab.push(id);
      for (const t of document.querySelectorAll('.tab-main')) t.style.display = t.id === id ? 'block' : 'none';
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
  const effective = Object.keys(EL).filter((id) => !denied.includes(id));
  const TAB = { more: 'tabMore', admin: 'tabAdmin' };
  w.ycLauncher = {
    isReady: () => true,
    effectiveRegistry: () => effective.map((id) => ({ id })),
    elementsOf: (id) => Object.assign({}, EL[id] || {}),   // returns hidden (denied) elements too
    exec: (id) => {
      w.__calls.exec.push(id);
      if (!effective.includes(id)) return false;          // denied / firm-hidden / admin-gated
      const m = EL[id];
      const sf = m.more ? 'more' : m.admin ? 'admin' : null;
      if (!sf) return false;
      w.openMainTab(TAB[sf]);
      const target = m[sf].getAttribute('data-target');
      if (!target) { w.__calls.dialog++; return true; }  // an action tile opens its dialog
      for (const t of d.querySelectorAll(`#${TAB[sf]} > .big-button[data-target]`)) {
        $(t.getAttribute('data-target')).style.display = t === m[sf] ? '' : 'none';
      }
      const f = $(target).querySelector(':scope > iframe[data-src]');
      if (f) { f.src = f.dataset.src; delete f.dataset.src; }
      w.syncWorkspaceUrl();                                // what syncDrillState does
      return true;
    },
  };
  const tick = () => new Promise((r) => w.setTimeout(r, 0));
  const lastOpen = () => new w.URL(w.__writes[w.__writes.length - 1]).searchParams.get('open');
  const showPanel = (id) => {
    for (const p of ['automationsDiv', 'manualsDiv']) $(p).style.display = p === id ? '' : 'none';
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
    expect(JSON.parse(JSON.stringify(w.wsDrillPanels('tabMore').map((p) => p.id)))).toEqual(['moreAutomations', 'moreManuals', 'moreUnplaced']);   // firm:tile skipped; an unplaced tile still maps (only the restore refuses it)
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

  test('a tile whose panel lives OUTSIDE the tab never maps to it (J6)', async () => {
    const { w, $, tick, lastOpen } = shell();
    w.enableWorkspaceUrlSync();
    w.openMainTab('tabMore');                              // tabMore's own panels all closed
    await tick();
    expect(w.getComputedStyle($('strayDiv')).display).not.toBe('none');   // visible, and an effective item's target
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
    // exitDrillMode, run for real: the panel closes and the URL follows
    const { w, $, showPanel } = shell();
    let syncs = 0;
    w.eval(fnSrc(SHELL, 'exitDrillMode'));
    w.syncWorkspaceUrl = () => { syncs++; };
    showPanel('automationsDiv');
    w.exitDrillMode($('tabMore'));
    expect($('automationsDiv').style.display).toBe('none');
    expect(syncs).toBe(1);
  });
});

describe('wsurl S2 — restore (openMainTabOnBoot), every refusal lands on the grid', () => {
  test('a panel id reopens through exec; the boot does NOT open the tab a second time', () => {
    const { w, $ } = shell();
    w.openMainTabOnBoot('tabMore', 'moreAutomations');
    expect(w.__calls.exec).toEqual(['moreAutomations']);
    expect(w.__calls.openMainTab).toEqual(['tabMore']);   // exec's own, once
    expect($('automationsDiv').style.display).toBe('');
    expect($('autoFrame').getAttribute('src')).toBe('/automationManager.html');
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
    expect(w.__calls.exec).toEqual(['moreAutomations']);
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
  test('owner: the DIRECT iframe of an effective item\'s panel → { tab, panel }; else null', () => {
    const { w, $ } = shell({ denied: ['moreManuals'] });
    expect(JSON.parse(JSON.stringify(w.wsFrameOwner($('autoFrame'))))).toEqual({ tab: 'tabMore', panel: 'moreAutomations' });
    expect(w.wsFrameOwner($('manFrame'))).toBeNull();      // its item is denied
    expect(w.wsFrameOwner($('deepFrame'))).toBeNull();     // nested in an EFFECTIVE panel, not its own
    expect(w.wsFrameOwner($('orphanFrame'))).toBeNull();   // no effective item owns that div
    expect(w.wsFrameOwner($('swalFrame'))).toBeNull();
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
