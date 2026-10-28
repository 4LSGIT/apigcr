'use strict';

// one test requires services/assistantService (its normalizeWorkspaceContext, pure): no read-only pool,
// as in tests/assistantService.test.js — on a dev machine 127.0.0.1:3306 is production
jest.mock('../startup/dbReadonly', () => ({}));

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const SHELL = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const ASSISTANT = fs.readFileSync(path.join(ROOT, 'public/assistant.html'), 'utf8');
const MANAGER = fs.readFileSync(path.join(ROOT, 'public/automationManager.html'), 'utf8');
const SUBTAB = fs.readFileSync(path.join(ROOT, 'public/js/ycSubTab.js'), 'utf8');
const NAVIGATION = SHELL.slice(
  SHELL.indexOf('    const YC_ASSISTANT_DESTINATIONS'),
  SHELL.indexOf('    // ---- Global auth state ----')
);

function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  const start = match.index;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}

function assignedFnSrc(src, name) {
  const start = src.indexOf(`window.${name} = function`);
  if (start < 0) throw new Error(`window.${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error(`window.${name} unbalanced`);
}

describe('Ask Casey sidebar host', () => {
  test('there is exactly one stable assistant iframe and no workspace panel twin', () => {
    const doc = new JSDOM(SHELL).window.document;
    expect(doc.querySelectorAll('iframe[src="/assistant.html"], iframe[data-src="/assistant.html"]')).toHaveLength(1);
    expect(doc.getElementById('caseyFrame')).not.toBeNull();
    expect(doc.getElementById('assistantDiv')).toBeNull();
    expect(doc.getElementById('askCaseyOpen').textContent).toMatch(/Ask Casey/);
  });

  test('collapse and expand reuse the iframe and never mutate the workspace URL', () => {
    const dom = new JSDOM('<!doctype html><body><iframe id="caseyFrame" data-src="/assistant.html"></iframe></body>', {
      url: 'https://app.test/?files=cCASE1234&open=file%3A0', runScripts: 'outside-only',
    });
    const w = dom.window;
    w.E = (id) => w.document.getElementById(id);
    w.matchMedia = () => ({ matches: false });
    w.caseySidebarPrior = null;
    w.document.body.classList.add('sidebar-skinny');
    w.eval(`${fnSrc(SHELL, 'openCasey')}\n${fnSrc(SHELL, 'closeCasey')}\n${fnSrc(SHELL, 'toggleCaseyExpanded')}`);
    const frame = w.E('caseyFrame');
    const before = w.location.href;
    expect(w.openCasey()).toBe(true);
    expect(frame.getAttribute('src')).toBe('/assistant.html');
    expect(w.closeCasey()).toBe(true);
    expect(w.document.body.classList.contains('sidebar-skinny')).toBe(true);
    expect(w.openCasey({ expanded: true })).toBe(true);
    expect(w.E('caseyFrame')).toBe(frame);
    expect(frame.hasAttribute('data-src')).toBe(false);
    expect(w.document.body.classList.contains('casey-expanded')).toBe(true);
    expect(w.location.href).toBe(before);
  });

  test('the narrow collector parses the canonical URL and keeps display names outside it', () => {
    const dom = new JSDOM('<!doctype html><body><div id="tabOpenFiles"><div class="file-button" title="Ada Case"></div></div></body>', {
      url: 'https://app.test/', runScripts: 'outside-only',
    });
    const w = dom.window;
    w.currentOpenFilesUrl = () => 'https://app.test/?files=cCASE1234%7Edocuments%2Cp42&open=file%3A0&ask=drop-me';
    w.ycSubTab = { normalize: (rest) => rest };
    w.eval(assignedFnSrc(SHELL, 'ycAssistantContext'));
    expect(w.ycAssistantContext()).toEqual({
      snapshot: {
        v: 1,
        canonical_url: '/?files=cCASE1234%7Edocuments%2Cp42&open=file%3A0',
        files: [
          { kind: 'case', id: 'CASE1234', rest: 'documents' },
          { kind: 'contact', id: '42', rest: '' },
        ],
        active: { kind: 'file', index: 0, entity: { kind: 'case', id: 'CASE1234', rest: 'documents' } },
      },
      display_label: 'Ada Case',
    });
    expect(w.ycAssistantContext().snapshot.canonical_url).not.toContain('Ada');
  });

  test('on a firm page (launcher-nits L4a: ?open=firm:<slug>) the chip reads the page\'s label, and the snapshot passes the server\'s own check', () => {
    const dom = new JSDOM('<!doctype html><body><div id="tabOpenFiles"></div></body>', { url: 'https://app.test/', runScripts: 'outside-only' });
    const w = dom.window;
    w.currentOpenFilesUrl = () => 'https://app.test/?open=firm%3Aops~moreAutomations~workflows';
    w.ycSubTab = { normalize: (rest) => rest };
    w.ycLauncher = { effectiveRegistry: () => [{ id: 'cases', label: 'Cases' }, { id: 'firm:ops', label: 'Operations' }] };
    w.eval(assignedFnSrc(SHELL, 'ycAssistantContext'));
    const ctx = w.ycAssistantContext();
    expect(JSON.parse(JSON.stringify(ctx.snapshot.active))).toEqual({ kind: 'workspace', tab: 'firm:ops', rest: 'moreAutomations~workflows' });
    expect(ctx.display_label).toBe('Operations');
    const snap = JSON.parse(JSON.stringify(ctx.snapshot));
    expect(require('../services/assistantService').normalizeWorkspaceContext(snap)).toEqual(snap);
    w.ycLauncher = { effectiveRegistry: () => [] };          // a page the launcher no longer lists: the generic label
    expect(w.ycAssistantContext().display_label).toBe('Current workspace');
  });

  test('workspace URL synchronization refreshes the long-lived assistant chip', () => {
    const sync = fnSrc(SHELL, 'syncWorkspaceUrl');
    expect(sync).toContain('history.replaceState(null, "", currentOpenFilesUrl())');
    expect(sync).toContain('frame.contentWindow.ycAssistantRefreshContext');
    expect(sync.indexOf('history.replaceState')).toBeLessThan(sync.indexOf('ycAssistantRefreshContext'));
  });

  test('send replaces a stale captured tab with the live contact unless the chip was removed', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const w = dom.window;
    const live = {
      snapshot: {
        v: 1,
        canonical_url: '/?files=p1309&open=file%3A0',
        files: [{ kind: 'contact', id: '1309', rest: '' }],
        active: { kind: 'file', index: 0, entity: { kind: 'contact', id: '1309', rest: '' } },
      },
      display_label: 'Chardonnay',
    };
    w.workspaceContextAttached = true;
    w.workspaceContext = { snapshot: { canonical_url: '/?open=tabCases' }, display_label: 'Cases' };
    w.captureWorkspaceContext = jest.fn(() => live);
    w.renderWorkspaceContext = jest.fn();
    w.eval(`${fnSrc(ASSISTANT, 'refreshWorkspaceContext')}\n${fnSrc(ASSISTANT, 'freezeWorkspaceContextForTurn')}`);

    const frozen = w.freezeWorkspaceContextForTurn();
    expect(frozen).toEqual(live);
    expect(w.workspaceContext).toEqual(live);
    live.snapshot.files[0].id = 'changed-after-freeze';
    expect(frozen.snapshot.files[0].id).toBe('1309');

    w.workspaceContextAttached = false;
    const calls = w.captureWorkspaceContext.mock.calls.length;
    expect(w.freezeWorkspaceContextForTurn()).toBeNull();
    expect(w.captureWorkspaceContext).toHaveBeenCalledTimes(calls);
    dom.window.close();
  });

  test('mobile uses the same host as a full-width sheet', () => {
    expect(SHELL).toMatch(/body\.casey-sidebar-open #appSidebar \{ transform: translateX\(0\); width: 100vw !important; \}/);
  });
});

describe('Automations → Court Review semantic navigation proof', () => {
  test('the shell registry is allowlisted and holds the cold rest before launcher execution', () => {
    expect(SHELL).toContain("'automations.court_review': Object.freeze({");
    expect(SHELL.indexOf('ycSubTab.host.hold(frame, rest)')).toBeLessThan(SHELL.indexOf('L.exec(spec.launcher, { page: spec.page })'));
    expect(SHELL).toContain("L.effectiveRegistry().some((item) => item.id === spec.launcher)");
  });

  test('the manager reports child load readiness and exposes only its narrow bridge', () => {
    expect(MANAGER).toContain("iframe.addEventListener('load', () => notifyAssistantDestinationReady(id), { once: true })");
    expect(MANAGER).toContain('ASSISTANT_DESTINATION_BY_SUB');
    expect(MANAGER).toContain('const parsed = parseAssistantRest(rest);');
    expect(MANAGER).toContain('window.ycAssistantOpenDestination = ycAssistantOpenDestination');
  });

  test('the manager bridge parses only its narrow token grammar and routes ids to the T4 focus', () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    const w = dom.window;
    const subPages = MANAGER.slice(MANAGER.indexOf('const SUB_PAGES = ['), MANAGER.indexOf('// ── Shell state'));
    const map = MANAGER.slice(MANAGER.indexOf('const ASSISTANT_DESTINATION_BY_SUB'), MANAGER.indexOf('function notifyAssistantDestinationReady'));
    w.focusCalls = [];
    w.switchCalls = [];
    const recordMap = MANAGER.slice(MANAGER.indexOf('const ASSISTANT_RECORD_BY_SUB'), MANAGER.indexOf('function ycAssistantOpenDestination'));
    w.eval(`${subPages}\n${map}\n${recordMap}\n${fnSrc(MANAGER, 'ycAssistantOpenDestination')}\n` +
      'function focusSubPageRecord(id, payload) { focusCalls.push([id, payload]); return true; }\n' +
      'function switchSubPage(id) { switchCalls.push(id); }\n' +
      'window.open_ = ycAssistantOpenDestination;');
    // The focus payload carries the RECORD kind, so the pane opens the
    // workflow/hook itself — not the Activity execution viewer (live bug:
    // the applied workflow-56 card opened execution #56).
    expect(w.open_('workflows~61')).toBe(true);
    expect(w.focusCalls).toEqual([['workflows', { id: 61, record: 'workflow' }]]);
    expect(w.open_('hooks~43')).toBe(true);
    expect(w.focusCalls[1]).toEqual(['hooks', { id: 43, record: 'hook' }]);
    expect(w.open_('courtReview')).toBe(true);
    expect(w.switchCalls).toEqual(['courtReview']);
    // Not in the destination map, malformed ids, and unknown tokens all fail closed.
    expect(w.open_('triggers')).toBe(false);
    expect(w.open_('workflows~61x')).toBe(false);
    expect(w.open_('workflows~')).toBe(false);
    expect(w.open_('evil~1')).toBe(false);
    // A17.7: a closed SECONDARY record kind routes an applied start card's id
    // to the workflows pane's execution viewer; anything else fails closed.
    expect(w.open_('workflows~77~execution')).toBe(true);
    expect(w.focusCalls[2]).toEqual(['workflows', { id: 77, record: 'execution' }]);
    expect(w.open_('workflows~77~evil')).toBe(false);
    expect(w.open_('hooks~77~execution')).toBe(false);
    expect(w.open_('workflows~77~execution~x')).toBe(false);
    expect(w.focusCalls).toHaveLength(3);
    // A18.4b: `enrollment` is the sequences pane's own secondary kind (an
    // applied enroll card) — and only that pane's.
    expect(w.open_('sequences~812~enrollment')).toBe(true);
    expect(w.focusCalls[3]).toEqual(['sequences', { id: 812, record: 'enrollment' }]);
    expect(w.open_('sequences~812~execution')).toBe(false);
    expect(w.open_('workflows~812~enrollment')).toBe(false);
    expect(w.open_('hooks~812~enrollment')).toBe(false);
    expect(w.focusCalls).toHaveLength(4);
    dom.window.close();
  });

  test('a cold manager queues the same secondary-record payload through the one parser', () => {
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    const w = dom.window;
    const subPages = MANAGER.slice(MANAGER.indexOf('const SUB_PAGES = ['), MANAGER.indexOf('// ── Shell state'));
    const map = MANAGER.slice(MANAGER.indexOf('const ASSISTANT_DESTINATION_BY_SUB'), MANAGER.indexOf('function notifyAssistantDestinationReady'));
    const recordMap = MANAGER.slice(MANAGER.indexOf('const ASSISTANT_RECORD_BY_SUB'), MANAGER.indexOf('function ycAssistantOpenDestination'));
    w.eval(`${subPages}\n${map}\n${recordMap}\nvar pendingFocus = {}; var held = null;\n` +
      'var ycSubTab = { leaf: { take: () => held } };\n' + fnSrc(MANAGER, 'wsBootSubPage') +
      '\nwindow.boot_ = (rest) => { held = rest; pendingFocus = {}; const page = wsBootSubPage(); return [page, pendingFocus]; };');
    expect(w.boot_('workflows~77~execution')).toEqual(['workflows', { workflows: { id: 77, record: 'execution' } }]);
    expect(w.boot_('workflows~61')).toEqual(['workflows', { workflows: { id: 61, record: 'workflow' } }]);
    expect(w.boot_('workflows~61~evil')).toEqual(['workflows', {}]);
    expect(w.boot_('sequences~812~enrollment')).toEqual(['sequences', { sequences: { id: 812, record: 'enrollment' } }]);
    expect(w.boot_('workflows~812~enrollment')).toEqual(['workflows', {}]);
    dom.window.close();
  });

  test('the workflows pane opens an execution-record payload in its execution viewer', () => {
    const PANE = fs.readFileSync(path.join(ROOT, 'public/automation/workflows.html'), 'utf8');
    const start = PANE.indexOf('window.onFocusRecord = (payload) => {');
    const src = PANE.slice(start, PANE.indexOf('};', start) + 2);
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.calls = [];
    w.eval('function selectWorkflow(id) { calls.push(["workflow", id]); }\nfunction viewWorkflowExecution(id) { calls.push(["execution", id]); }\n' + src);
    w.onFocusRecord({ id: 77, record: 'execution' });
    w.onFocusRecord({ id: 61, record: 'workflow' });
    expect(w.calls).toEqual([['execution', 77], ['workflow', 61]]);
    dom.window.close();
  });

  test('the sequences pane opens an enrollment-record payload in its enrollment viewer', () => {
    const PANE = fs.readFileSync(path.join(ROOT, 'public/automation/sequences.html'), 'utf8');
    const start = PANE.indexOf('window.onFocusRecord = (payload) => {');
    const src = PANE.slice(start, PANE.indexOf('};', start) + 2);
    const dom = new JSDOM('<!doctype html>', { runScripts: 'outside-only' });
    const w = dom.window;
    w.calls = [];
    w.eval('function selectSeqTemplate(id) { calls.push(["sequence", id]); }\nfunction viewSequenceEnrollment(id) { calls.push(["enrollment", id]); }\n' + src);
    w.onFocusRecord({ id: 812, record: 'enrollment' });
    w.onFocusRecord({ id: 12, record: 'sequence' });
    expect(w.calls).toEqual([['enrollment', 812], ['sequence', 12]]);
    dom.window.close();
  });

  function navigationWorld(cold) {
    const attr = cold ? ' data-src="/automationManager.html"' : ' src="/automationManager.html"';
    const dom = new JSDOM(`<!doctype html><body><div id="automationsDiv"><iframe${attr}></iframe></div></body>`, {
      url: 'https://app.test/', runScripts: 'outside-only',
    });
    const w = dom.window;
    const frame = w.document.querySelector('iframe');
    w.E = (id) => w.document.getElementById(id);
    w.eval(SUBTAB);
    const exec = jest.fn(() => {
      if (cold) { frame.src = frame.dataset.src; delete frame.dataset.src; }
      return true;
    });
    w.ycLauncher = {
      isReady: () => true,
      effectiveRegistry: () => [{ id: 'moreAutomations' }],
      exec,
    };
    w.eval(NAVIGATION);
    return { dom, w, frame, exec };
  }

  test('cold navigation holds Court Review, opens through the launcher, then waits for child ready', async () => {
    const t = navigationWorld(true);
    const promise = t.w.ycAssistantNavigate('automations.court_review');
    expect(t.exec).toHaveBeenCalledWith('moreAutomations', { page: 'tabMore' });
    expect(t.w.ycSubTab.host.lastRest(t.frame)).toBe('courtReview');
    expect(t.w.ycAssistantChildReady(t.frame, { destination: 'automations.court_review' })).toBe(true);
    await expect(promise).resolves.toEqual({ destination: 'automations.court_review', ready: true });
    t.dom.window.close();
  });

  test('already-loaded navigation calls the same manager bridge and clears the cold hold', async () => {
    const t = navigationWorld(false);
    let opened = null;
    t.frame.contentWindow.ycAssistantOpenDestination = (rest) => {
      opened = rest;
      t.w.ycAssistantChildReady(t.frame, { destination: 'automations.court_review' });
      return true;
    };
    await expect(t.w.ycAssistantNavigate('automations.court_review')).resolves.toMatchObject({ ready: true });
    expect(opened).toBe('courtReview');
    expect(t.w.ycSubTab.host.take(t.frame)).toBeNull();
    t.dom.window.close();
  });

  test('a record deep link holds <sub>~<id> and resolves on its own destination handshake', async () => {
    const t = navigationWorld(true);
    const promise = t.w.ycAssistantNavigate('automations.workflow', { id: 61 });
    expect(t.w.ycSubTab.host.lastRest(t.frame)).toBe('workflows~61');
    expect(t.w.ycAssistantChildReady(t.frame, { destination: 'automations.workflow' })).toBe(true);
    await expect(promise).resolves.toEqual({ destination: 'automations.workflow', ready: true });
    t.dom.window.close();
  });

  test('a secondary record kind rides the rest only from the destination\'s own frozen list', async () => {
    const t = navigationWorld(true);
    const promise = t.w.ycAssistantNavigate('automations.workflow', { id: 77, record: 'execution' });
    expect(t.w.ycSubTab.host.lastRest(t.frame)).toBe('workflows~77~execution');
    expect(t.w.ycAssistantChildReady(t.frame, { destination: 'automations.workflow' })).toBe(true);
    await expect(promise).resolves.toEqual({ destination: 'automations.workflow', ready: true });
    t.dom.window.close();
    const u = navigationWorld(false);
    for (const [destination, params] of [['automations.workflow', { id: 77, record: 'evil' }], ['automations.workflow', { id: 77, record: 'execution~x' }],
      ['automations.hook', { id: 77, record: 'execution' }], ['automations.workflow', { id: 77, record: null }],
      ['automations.workflow', { id: 77, record: 'enrollment' }], ['automations.sequence', { id: 77, record: 'execution' }]]) {
      await expect(u.w.ycAssistantNavigate(destination, params)).rejects.toThrow(/malformed/);
    }
    expect(u.exec).not.toHaveBeenCalled();
    u.dom.window.close();
    // A18.4b: the sequence destination's own list carries `enrollment`.
    const v = navigationWorld(true);
    const enrolled = v.w.ycAssistantNavigate('automations.sequence', { id: 812, record: 'enrollment' });
    expect(v.w.ycSubTab.host.lastRest(v.frame)).toBe('sequences~812~enrollment');
    expect(v.w.ycAssistantChildReady(v.frame, { destination: 'automations.sequence' })).toBe(true);
    await expect(enrolled).resolves.toEqual({ destination: 'automations.sequence', ready: true });
    v.dom.window.close();
  });

  test('a malformed record id rejects before the launcher runs — the id is shell-validated', async () => {
    const t = navigationWorld(false);
    for (const params of [undefined, {}, { id: 0 }, { id: '61; DROP' }, { id: 1.5 }]) {
      await expect(t.w.ycAssistantNavigate('automations.workflow', params)).rejects.toThrow(/malformed/);
    }
    expect(t.exec).not.toHaveBeenCalled();
    t.dom.window.close();
  });

  test('unknown or inaccessible destinations fail closed before launcher execution', async () => {
    const t = navigationWorld(false);
    await expect(t.w.ycAssistantNavigate('evil.selector')).rejects.toThrow(/not available/);
    expect(t.exec).not.toHaveBeenCalled();
    t.dom.window.close();
  });
});
