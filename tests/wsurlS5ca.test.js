/**
 * ui-custom S5c-a — the manager panes under More remember their sub-tab in
 * the workspace URL:  ?open=tabMore~moreAutomations~triggers
 *                     ?open=tabMore~moreCaseConfig~pipelines
 *
 * automationManager.html and caseConfigManager.html are ycSubTab LEAVES in a
 * drill panel's direct iframe; the shell side (hold / take / noteReport, the
 * panel rest in the URL) is wsurl S2's, generic over every drill panel and
 * tested in tests/wsurlS2.test.js.
 *
 * Each page runs here as REAL code in a REAL jsdom frame: its own markup
 * (scripts stripped) and its whole shipped inline script, plus the real
 * public/js/ycSubTab.js. Tab clicks are DISPATCHED on the rendered buttons,
 * so their inline onclick runs as shipped. Two hosts:
 *   · a stub host recording reports / answering take (the leaf contract);
 *   · the REAL shell functions extracted from public/index.html (the fnSrc
 *     pattern of tests/wsurlS2.test.js), with ycLauncher stubbed at its
 *     public API: boot restore → hold → the frame boots → take → its switch
 *     → report → the URL.
 * The real-browser round trips are in scripts/mobile-survey/wsurl.js (a*).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODULE = read('public/js/ycSubTab.js');
const SHELL = read('public/index.html');
const PAGES = {
  automations: read('public/automationManager.html'),
  caseConfig: read('public/caseConfigManager.html'),
};
const IDS = {
  automations: ['workflows', 'sequences', 'scheduledJobs', 'hooks', 'triggers', 'emailIngest', 'phoneIngest', 'courtReview', 'activity'],
  caseConfig: ['types', 'pipelines', 'fields', 'caltypes', 'firm'],
};

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

/** The page's one inline <script> (no src), as shipped. */
function inlineScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (blocks.length !== 1) throw new Error('expected ONE inline script, got ' + blocks.length);
  return blocks[0][1];
}

const flush = (w) => new Promise((r) => w.setTimeout(r, 0));

/**
 * Boot the page in `frame` (a jsdom iframe of a runScripts:'dangerously'
 * window): markup without scripts, the real ycSubTab.js, then the page's
 * whole inline script — its boot line included, exactly as shipped.
 */
function bootPage(page, frame) {
  const w = frame.contentWindow;
  w.document.body.innerHTML = PAGES[page].replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
  w.eval(MODULE);
  w.eval(inlineScript(PAGES[page]));
  return w;
}

/** The shown sub-tab, read from the DOM (the page's `let activeSubPageId`
 *  lives in its script's own lexical scope, out of reach of window). */
const activeOf = (w) => {
  const on = w.document.querySelectorAll('.tab-nav-btn.active');
  return on.length === 1 ? on[0].id.replace(/^tabnav-/, '') : on.length;
};
const tabBtn = (w, id) => w.document.getElementById('tabnav-' + id);

/** The leaf under a stub host that records reports and answers take(). */
function stubbed(page, { held = null, uiConfig = { can_edit_firm: true }, hold = null } = {}) {
  const shell = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
  const frame = shell.document.createElement('iframe');
  shell.document.body.appendChild(frame);
  const reports = [];
  const takes = [];
  let pending = held;
  shell.ycReportSubTab = (f, r) => reports.push([f === frame, r]);
  shell.ycTakeSubTab = (f) => { const r = f === frame ? pending : null; takes.push(r); pending = null; return r; };
  // caseConfigManager's boot asks GET /api/ui-config (the Firm tab's gate)
  let release;
  const gate = hold ? new Promise((r) => { release = r; }) : null;
  shell.apiSend = async (url) => {
    if (gate) await gate;
    if (url !== '/api/ui-config') return {};
    if (uiConfig instanceof Error) throw uiConfig;
    return uiConfig;
  };
  const w = bootPage(page, frame);
  return { shell, frame, w, reports, takes, release: () => release && release() };
}

// ─────────────────────────────────────────────────────────────────────────────
describe.each(['automations', 'caseConfig'])('%s — the leaf', (page) => {
  test('loads /js/ycSubTab.js; its SUB_PAGES ids are the vocabulary: valid segments, unique, pinned', () => {
    expect(PAGES[page]).toMatch(/<script src="\/js\/ycSubTab\.js"><\/script>/);
    const { w } = stubbed(page);
    // rendered from SUB_PAGES, one button per entry (tabnav-<id>)
    const ids = [...w.document.querySelectorAll('.tab-nav-btn')].map((b) => b.id.replace(/^tabnav-/, ''));
    expect(ids).toEqual(IDS[page]);
    ids.forEach((id) => expect(id).toMatch(/^[A-Za-z0-9_-]{1,32}$/));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('a click on every sub-tab button reports its id; the default reports ""', async () => {
    const { w, reports } = stubbed(page);
    await flush(w); await flush(w);                         // caseConfig: the Firm tab revealed
    for (const id of IDS[page]) {
      reports.length = 0;
      tabBtn(w, id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));   // the shipped inline onclick
      expect([id, activeOf(w), reports]).toEqual([id, id, [[true, id === IDS[page][0] ? '' : id]]]);
    }
  });

  test('boot with no held rest: the default, reported as ""; take() asked exactly once', () => {
    const { w, reports, takes } = stubbed(page);
    expect(activeOf(w)).toBe(IDS[page][0]);
    expect(reports).toEqual([[true, '']]);
    expect(takes).toEqual([null]);
  });

  test('boot restores a held sub-tab; an unknown token → the default, silently', () => {
    const target = IDS[page][2];
    for (const [held, want] of [[target, target], [target + '~42~x', target], ['bogus', IDS[page][0]],
      ['', IDS[page][0]], [null, IDS[page][0]], ['x"><img id=pwn src=x>', IDS[page][0]],
      [target.toUpperCase(), IDS[page][0]], ['tabnav-' + target, IDS[page][0]], ['constructor', IDS[page][0]]]) {
      const { w, reports, takes } = stubbed(page, { held });
      expect([held, activeOf(w)]).toEqual([held, want]);
      expect([held, reports]).toEqual([held, [[true, want === IDS[page][0] ? '' : want]]]);
      expect(takes).toHaveLength(1);
      expect(w.document.getElementById('pwn')).toBeNull();
      expect(w.document.querySelectorAll('.subpage-panel.active')).toHaveLength(1);
    }
  });

  test('unframed: boots on the default, nothing reported, nothing throws', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
      { url: 'https://app.4lsg.com/x.html', runScripts: 'dangerously' });
    const w = dom.window;
    let called = 0;
    w.ycReportSubTab = () => { called++; };
    w.ycTakeSubTab = () => { called++; return IDS[page][1]; };
    w.apiSend = async () => ({});
    w.document.body.innerHTML = PAGES[page].replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
    w.eval(MODULE);
    expect(() => w.eval(inlineScript(PAGES[page]))).not.toThrow();
    expect(activeOf(w)).toBe(IDS[page][0]);
    expect(called).toBe(0);
  });
});

describe('automationManager — the one switch', () => {
  test('focusSubPageRecord (Activity deep links) reports through switchSubPage', () => {
    const { w, reports } = stubbed('automations');
    reports.length = 0;
    w.focusSubPageRecord('triggers', { id: 1 });
    expect(reports).toEqual([[true, 'triggers']]);
    w.close();   // stops the drain's onFocusRecord poll (no sub-page boots here)
  });
});

describe('caseConfigManager — a gated sub-tab (Firm) waits for its reveal', () => {
  test('held "firm": boots on the default, then opens Firm once the reveal shows it', async () => {
    const { w, reports } = stubbed('caseConfig', { held: 'firm' });
    expect(activeOf(w)).toBe('types');
    await flush(w); await flush(w);
    expect(tabBtn(w, 'firm').hidden).toBe(false);
    expect(activeOf(w)).toBe('firm');
    expect(reports).toEqual([[true, ''], [true, 'firm']]);
  });

  test('not revealed (can_edit_firm false, or the fetch fails): the default stays', async () => {
    for (const uiConfig of [{ can_edit_firm: false }, new Error('500')]) {
      const { w, reports } = stubbed('caseConfig', { held: 'firm', uiConfig });
      await flush(w); await flush(w);
      expect(tabBtn(w, 'firm').hidden).toBe(true);
      expect(activeOf(w)).toBe('types');
      expect(reports).toEqual([[true, '']]);
    }
  });

  test('the user moved before the reveal answered: they are not yanked to Firm', async () => {
    const { w, reports, release } = stubbed('caseConfig', { held: 'firm', hold: true });
    tabBtn(w, 'pipelines').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    release();
    await flush(w); await flush(w); await flush(w);
    expect(tabBtn(w, 'firm').hidden).toBe(false);
    expect(activeOf(w)).toBe('pipelines');
    expect(reports).toEqual([[true, ''], [true, 'pipelines']]);
  });

  test('a non-gated held id never waits for the reveal', () => {
    const { w } = stubbed('caseConfig', { held: 'caltypes', hold: true });
    expect(activeOf(w)).toBe('caltypes');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The REAL shell around the REAL pages.
const DOM = `<!DOCTYPE html><html><body>
  <div id="tabOpenFiles"></div>
  <div id="tabHome" class="tab-main" style="display:block"></div>
  <div id="tabCases" class="tab-main" style="display:none"></div>
  <div id="tabMore" class="tab-main" style="display:none">
    <button class="big-button" id="tCfg" data-target="caseConfigDiv" data-exclusive-group="more">Config</button>
    <button class="big-button" id="tAuto" data-target="automationsDiv" data-exclusive-group="more">Automations</button>
    <div id="caseConfigDiv" style="display:none"><iframe id="cfgFrame"></iframe></div>
    <div id="automationsDiv" style="display:none"><iframe id="autoFrame"></iframe></div>
  </div>
</body></html>`;

function realShell() {
  const dom = new JSDOM(DOM, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = dom.window;
  const d = w.document;
  w.eval(MODULE);
  w.__writes = [];
  w.history.replaceState = (s, t, url) => w.__writes.push(url);
  w.apiSend = async (url) => (url === '/api/ui-config' ? { can_edit_firm: true } : {});
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
      for (const t of document.querySelectorAll('.tab-main')) t.style.display = t.id === id ? 'block' : 'none';
      syncWorkspaceUrl();
    }
  `);
  const $ = (id) => d.getElementById(id);
  const EL = { moreAutomations: { more: $('tAuto') }, moreCaseConfig: { more: $('tCfg') } };
  const FRAME = { automationsDiv: ['automations', 'autoFrame'], caseConfigDiv: ['caseConfig', 'cfgFrame'] };
  const booted = {};
  /** What the click handler does: show the panel, its iframe boots ONCE (the lazy load). */
  const showPanel = (target) => {
    for (const t of d.querySelectorAll('#tabMore > .big-button[data-target]')) {
      $(t.getAttribute('data-target')).style.display = t.getAttribute('data-target') === target ? '' : 'none';
    }
    const [page, fid] = FRAME[target];
    if (!booted[fid]) booted[fid] = bootPage(page, $(fid));
    w.syncWorkspaceUrl();
  };
  w.ycLauncher = {
    isReady: () => true,
    effectiveRegistry: () => Object.keys(EL).map((id) => ({ id })),
    elementsOf: (id) => Object.assign({}, EL[id] || {}),
    exec: (id) => {
      if (!EL[id]) return false;
      w.openMainTab('tabMore');
      showPanel(EL[id].more.getAttribute('data-target'));
      return true;
    },
  };
  const lastOpen = () => new w.URL(w.__writes[w.__writes.length - 1]).searchParams.get('open');
  const pane = (fid) => booted[fid];
  return { w, $, showPanel, lastOpen, pane, flush: () => flush(w) };
}

describe('the real shell + the real panes: drill → sub-tab → URL → restore', () => {
  test('a cold boot of ?open=tabMore~moreAutomations~triggers: the pane takes the held rest and shows Triggers', async () => {
    const s = realShell();
    s.w.enableWorkspaceUrlSync();
    const t = s.w.wsOpenTarget('tabMore~moreAutomations~triggers');
    expect({ ...t }).toEqual({ tab: 'tabMore', rest: 'moreAutomations~triggers' });
    s.w.openMainTabOnBoot(t.tab, t.rest);
    await s.flush();
    expect(activeOf(s.pane('autoFrame'))).toBe('triggers');
    expect(s.lastOpen()).toBe('tabMore~moreAutomations~triggers');
    expect(s.w.ycTakeSubTab(s.$('autoFrame'))).toBeNull();   // taken once, by the pane
  });

  test('clicking a sub-tab moves the URL; the default drops the segment', async () => {
    const s = realShell();
    s.w.enableWorkspaceUrlSync();
    s.w.openMainTab('tabMore');
    s.showPanel('automationsDiv');
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreAutomations');
    const p = s.pane('autoFrame');
    tabBtn(p, 'hooks').dispatchEvent(new p.MouseEvent('click', { bubbles: true }));
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreAutomations~hooks');
    tabBtn(p, 'workflows').dispatchEvent(new p.MouseEvent('click', { bubbles: true }));
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreAutomations');
  });

  test('an invalid sub-tab token: the default, and the URL settles without it', async () => {
    const s = realShell();
    s.w.enableWorkspaceUrlSync();
    s.w.openMainTabOnBoot('tabMore', 'moreAutomations~bogus');
    await s.flush();
    expect(activeOf(s.pane('autoFrame'))).toBe('workflows');
    expect(s.lastOpen()).toBe('tabMore~moreAutomations');
  });

  test('switching panels and back keeps each pane\'s sub-tab, and the URL follows the open one', async () => {
    const s = realShell();
    s.w.enableWorkspaceUrlSync();
    s.w.openMainTab('tabMore');
    s.showPanel('automationsDiv');
    const a = s.pane('autoFrame');
    tabBtn(a, 'activity').dispatchEvent(new a.MouseEvent('click', { bubbles: true }));
    s.showPanel('caseConfigDiv');
    const c = s.pane('cfgFrame');
    tabBtn(c, 'pipelines').dispatchEvent(new c.MouseEvent('click', { bubbles: true }));
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreCaseConfig~pipelines');
    s.showPanel('automationsDiv');
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreAutomations~activity');
    expect(activeOf(a)).toBe('activity');
    // another main tab and back
    s.w.openMainTab('tabCases');
    await s.flush();
    expect(s.lastOpen()).toBe('tabCases');
    s.w.openMainTab('tabMore');
    await s.flush();
    expect(s.lastOpen()).toBe('tabMore~moreAutomations~activity');
  });

  test('caseConfig: ?open=tabMore~moreCaseConfig~firm restores Firm after its reveal', async () => {
    const s = realShell();
    s.w.enableWorkspaceUrlSync();
    s.w.openMainTabOnBoot('tabMore', 'moreCaseConfig~firm');
    const c = s.pane('cfgFrame');
    expect(activeOf(c)).toBe('types');                     // gated: waits for the reveal
    await flush(c); await flush(c); await s.flush();
    expect(activeOf(c)).toBe('firm');
    expect(s.lastOpen()).toBe('tabMore~moreCaseConfig~firm');
  });
});
