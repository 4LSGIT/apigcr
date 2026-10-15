/**
 * wsurl S1a — the workspace URL carries sub-state (shell side).
 *
 *   · public/js/ycSubTab.js, the REAL file: the rest grammar (charset, caps,
 *     empties, depth), the host caches (take-once, a handed-down rest counts as
 *     the child's report) and the leaf calls (no-ops unframed; real nested
 *     jsdom frames when framed).
 *   · The shell's receiver and ?open= validation, REAL code extracted from
 *     public/index.html (the fnSrc pattern of tests/unifiedEventsU9.shell.test.js)
 *     and run over a small DOM: ycReportSubTab / ycTakeSubTab, the hidden-file
 *     pending rule, the one-replaceState-per-tick sync, wsOpenTarget +
 *     wsMainTabAllowed against a stub of ycLauncher's PUBLIC API.
 *
 * The real-browser round trips (boot → URL → reload, roles, opener counts)
 * live in scripts/mobile-survey/wsurl.js.
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

/** `window.NAME = function (…) {…};` as shipped. */
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

function moduleWindow(html = '<!DOCTYPE html><html><body></body></html>') {
  const dom = new JSDOM(html, { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
  dom.window.eval(MODULE);
  return dom.window;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('ycSubTab.parse / valid / normalize', () => {
  const T = moduleWindow().ycSubTab;
  const S32 = 'a'.repeat(32);

  test.each([
    ['', []], [null, []], [undefined, []],
    ['documents', ['documents']],
    ['a~b~c~d', ['a', 'b', 'c', 'd']],
    ['ISSN', ['ISSN']], ['341', ['341']], ['moreAutomations', ['moreAutomations']], ['a_b-c', ['a_b-c']],
    ['a~', ['a']], ['a~b~~', ['a', 'b']],                 // trailing empties stripped
    ['a~~b', ['a']], ['~a', []], ['a~~b~c~d~e~f', ['a']], // an empty = default, drops the rest
    [S32, [S32]],
    [[S32, S32, S32, 'a'.repeat(29)].join('~'), [S32, S32, S32, 'a'.repeat(29)]],   // exactly 128
  ])('valid: %j → %j', (rest, segs) => {
    expect(T.parse(rest)).toEqual(segs);
    expect(T.valid(rest)).toBe(true);
    expect(T.normalize(rest)).toBe(segs.join('~'));
  });

  test.each([
    ['a~b~c~d~e'],                                      // depth 5
    ['a'.repeat(33)],                                   // segment over 32
    [[S32, S32, S32, 'a'.repeat(30)].join('~')],        // 129 chars
    ['a~~<x>'],                                         // charset checked after an empty too
    ['x"></iframe><img id=pwn src=x>'],                 // the S0 payloads
    ['documents&fileCount=9'], ["o'x"], ["\\';x//"], [' documents'], ['doc uments'],
    ['a.b'], ['a/b'], ['a,b'], ['a%7Eb'], ['é'],
    [5], [{}], [['a']],
  ])('invalid: %j', (rest) => {
    expect(T.parse(rest)).toBeNull();
    expect(T.valid(rest)).toBe(false);
    expect(T.normalize(rest)).toBeNull();
  });

  test('for ONE segment, at least as strict as S0\'s ycSubTabOk', () => {
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    dom.window.eval(fnSrc(SHELL, 'ycSubTabOk'));
    const ok = dom.window.ycSubTabOk;
    const corpus = ['documents', 'ISSN', '341', 'a'.repeat(32), 'a'.repeat(33), '', 'a b', 'a"b',
      "a'b", 'a\\b', 'a<b', 'a&b', 'a=b', 'a.b', 'a%b', 'a\nb', '-', '_', 'é', 'Ａ'];
    for (const s of corpus) if (T.valid(s) && s !== '') expect([s, ok(s)]).toEqual([s, true]);
  });
});

describe('ycSubTab.host — per-frame caches', () => {
  test('take() hands the held rest over ONCE', () => {
    const w = moduleWindow();
    const H = w.ycSubTab.host;
    const f = w.document.createElement('iframe');
    H.hold(f, 'documents~x');
    expect(H.take(f)).toBe('documents~x');
    expect(H.take(f)).toBeNull();
  });

  test('a handed-down rest counts as the child\'s report until it reports', () => {
    const w = moduleWindow();
    const H = w.ycSubTab.host;
    const f = w.document.createElement('iframe');
    expect(H.lastRest(f)).toBeNull();
    H.hold(f, 'documents~x');
    expect(H.lastRest(f)).toBe('documents~x');
    H.take(f);
    expect(H.lastRest(f)).toBe('documents~x');          // taken, still its last word
    H.noteReport(f, 'tasks');
    expect(H.lastRest(f)).toBe('tasks');
    H.noteReport(f, '');                                  // back to its default
    expect(H.lastRest(f)).toBe('');
  });

  test('invalid rests change nothing; frames are independent; non-frames ignored', () => {
    const w = moduleWindow();
    const H = w.ycSubTab.host;
    const a = w.document.createElement('iframe');
    const b = w.document.createElement('iframe');
    H.hold(a, 'x"><b>');
    expect(H.take(a)).toBeNull();
    expect(H.lastRest(a)).toBeNull();
    H.hold(a, 'one');
    H.noteReport(a, 'a~b~c~d~e');
    expect(H.lastRest(a)).toBe('one');
    expect(H.take(b)).toBeNull();
    H.hold(null, 'x'); H.noteReport('str', 'x');
    expect(H.take(null)).toBeNull();
    expect(H.lastRest('str')).toBeNull();
  });
});

describe('ycSubTab.leaf', () => {
  test('unframed: report and take are no-ops', () => {
    const w = moduleWindow();
    let called = false;
    w.ycReportSubTab = () => { called = true; };
    w.ycSubTab.leaf.report('documents');
    expect(called).toBe(false);
    expect(w.ycSubTab.leaf.take()).toBeNull();
  });

  test('framed: reaches the PARENT (not top) with its own frameElement', () => {
    const top = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
    const mid = top.document.createElement('iframe');
    top.document.body.appendChild(mid);
    const leafFrame = mid.contentWindow.document.createElement('iframe');
    mid.contentWindow.document.body.appendChild(leafFrame);
    const leaf = leafFrame.contentWindow;
    const seen = { top: [], mid: [] };
    top.ycReportSubTab = (f, r) => seen.top.push([f, r]);
    mid.contentWindow.ycReportSubTab = (f, r) => seen.mid.push([f, r]);
    mid.contentWindow.ycTakeSubTab = (f) => (f === leafFrame ? 'held~x' : null);
    leaf.eval(MODULE);
    leaf.ycSubTab.leaf.report('tasks');
    expect(seen.mid).toEqual([[leafFrame, 'tasks']]);
    expect(seen.top).toEqual([]);
    expect(leaf.ycSubTab.leaf.take()).toBe('held~x');
    // a host that throws never breaks the leaf
    mid.contentWindow.ycReportSubTab = () => { throw new Error('boom'); };
    mid.contentWindow.ycTakeSubTab = () => { throw new Error('boom'); };
    expect(() => leaf.ycSubTab.leaf.report('x')).not.toThrow();
    expect(leaf.ycSubTab.leaf.take()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shell's receiver, over a DOM shaped like the shell's: two open files
// (file-div1 active, file-div2 hidden), a main tab with a pane frame, a main
// tab without one, and a frame in a Swal-like container outside both.
const SHELL_DOM = `<!DOCTYPE html><html><body>
  <div id="tabOpenFiles">
    <div class="file-button" id="file-button1" data-file-id="file-div1" title="A" data-file-spec="cABCD2345~documents"></div>
    <div class="file-button" id="file-button2" data-file-id="file-div2" title="B" data-file-spec="p1405"></div>
  </div>
  <div id="tabHome" class="tab-main" style="display:none"></div>
  <div id="tabAll" class="tab-main" style="display:none"></div>
  <div id="tabCases" class="tab-main" style="display:none"></div>
  <div id="tabComms" class="tab-main" style="display:none"><iframe id="commsFrame"></iframe></div>
  <div id="tabMore" class="tab-main" style="display:none"><div id="automationsDiv"><iframe id="panelFrame"></iframe></div></div>
  <div id="tabAdmin" class="tab-main" style="display:none"></div>
  <div id="tabSettings" class="tab-main" style="display:none"></div>
  <div id="file-div1" class="tab-main file" style="display:block"><iframe id="f1"></iframe></div>
  <div id="file-div2" class="tab-main file" style="display:none"><iframe id="f2"></iframe></div>
  <div class="swal2-container"><iframe id="swalFrame"></iframe></div>
  <div id="sbAdmin"></div>
</body></html>`;

function shell() {
  const dom = new JSDOM(SHELL_DOM, { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
  const w = dom.window;
  w.eval(MODULE);
  w.__writes = [];
  w.history.replaceState = (s, t, url) => w.__writes.push(url);
  const pick = (re) => { const m = re.exec(SHELL); if (!m) throw new Error('not found: ' + re); return m[0]; };
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
    ${fnSrc(SHELL, 'wsSetFileRest')}
    ${fnSrc(SHELL, 'wsFrameOwner')}
    ${assignedFnSrc(SHELL, 'ycReportSubTab')}
    ${assignedFnSrc(SHELL, 'ycTakeSubTab')}
    ${fnSrc(SHELL, 'wsOpenTarget')}
    ${fnSrc(SHELL, 'wsMainTabAllowed')}
    ${fnSrc(SHELL, 'currentOpenFilesUrl')}
    window.__ws = { get main() { return wsMainRest; } };
  `);
  const tick = () => new Promise((r) => w.setTimeout(r, 0));
  const show = (id) => {
    for (const el of w.document.querySelectorAll('.tab-main')) el.style.display = el.id === id ? 'block' : 'none';
  };
  const $ = (id) => w.document.getElementById(id);
  const lastUrl = () => new w.URL(w.__writes[w.__writes.length - 1]);
  return { w, tick, show, $, lastUrl };
}

describe('shell receiver — ycReportSubTab / ycTakeSubTab', () => {
  test('the active file\'s report rewrites its token; ONE replaceState per tick', async () => {
    const { w, tick, $, lastUrl } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    w.__writes.length = 0;
    w.ycReportSubTab($('f1'), 'tasks');
    w.ycReportSubTab($('f1'), 'tasks~x');
    w.ycReportSubTab($('f1'), 'checklists~a~b');
    expect(w.__writes).toHaveLength(0);                    // queued, not yet written
    await tick();
    expect(w.__writes).toHaveLength(1);
    expect(lastUrl().searchParams.get('files')).toBe('cABCD2345~checklists~a~b,p1405');
    expect(lastUrl().searchParams.get('open')).toBe('file:0');
    expect($('file-button1').dataset.fileSpec).toBe('cABCD2345~checklists~a~b');
    // the default ('') drops the rest
    w.ycReportSubTab($('f1'), '');
    await tick();
    expect(lastUrl().searchParams.get('files')).toBe('cABCD2345,p1405');
  });

  test('a HIDDEN file\'s report changes nothing until that file is shown', async () => {
    const { w, tick, show, $, lastUrl } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    w.__writes.length = 0;
    w.ycReportSubTab($('f2'), 'cases');
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect($('file-button2').dataset.fileSpec).toBe('p1405');
    expect(w.currentOpenFilesUrl()).not.toContain('cases');   // even an unprompted serialise
    show('file-div2');
    w.syncWorkspaceUrl();                                     // what openMainTab does
    await tick();
    expect(lastUrl().searchParams.get('files')).toBe('cABCD2345~documents,p1405~cases');
    expect(lastUrl().searchParams.get('open')).toBe('file:1');
  });

  test('ignored: a Swal frame, a nested panel frame, a foreign element, invalid rests', async () => {
    const { w, tick, $ } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    const before = w.currentOpenFilesUrl();
    w.__writes.length = 0;
    w.ycReportSubTab($('swalFrame'), 'tasks');
    w.ycReportSubTab($('panelFrame'), 'tasks');
    w.ycReportSubTab($('tabOpenFiles'), 'tasks');
    w.ycReportSubTab(null, 'tasks');
    for (const bad of ['x"><img id=pwn>', 'a'.repeat(33), 'a~b~c~d~e', "\\';x//"]) w.ycReportSubTab($('f1'), bad);
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect(w.currentOpenFilesUrl()).toBe(before);
    expect(w.__ws.main).toEqual({});
  });

  test('a main tab\'s pane: stored, shown only while active, never opens anything', async () => {
    const { w, tick, show, $, lastUrl } = shell();
    w.enableWorkspaceUrlSync();
    await tick();
    w.__writes.length = 0;
    w.ycReportSubTab($('commsFrame'), 'phone~a');           // tabComms hidden: silent
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect(w.__ws.main).toEqual({ tabComms: 'phone~a' });
    expect($('file-div1').style.display).toBe('block');       // nothing was switched
    show('tabComms');
    w.syncWorkspaceUrl();
    await tick();
    expect(lastUrl().searchParams.get('open')).toBe('tabComms~phone~a');
    w.ycReportSubTab($('commsFrame'), 'email');
    await tick();
    expect(lastUrl().searchParams.get('open')).toBe('tabComms~email');
  });

  test('the gate: reports while closed store state, write nothing', async () => {
    const { w, tick, $ } = shell();
    w.ycReportSubTab($('f1'), 'tasks');
    await tick();
    expect(w.__writes).toHaveLength(0);
    expect($('file-button1').dataset.fileSpec).toBe('cABCD2345~tasks');
    w.enableWorkspaceUrlSync();
    await tick();
    expect(w.__writes).toHaveLength(1);
  });

  test('ycTakeSubTab: once, and only for a workspace pane frame', () => {
    const { w, $ } = shell();
    w.ycSubTab.host.hold($('f1'), 'documents~x');
    w.ycSubTab.host.hold($('swalFrame'), 'documents~x');
    expect(w.ycTakeSubTab($('f1'))).toBe('documents~x');
    expect(w.ycTakeSubTab($('f1'))).toBeNull();
    expect(w.ycTakeSubTab($('swalFrame'))).toBeNull();
  });
});

describe('shell ?open= — wsOpenTarget / wsMainTabAllowed (fail closed)', () => {
  /** ycLauncher's public API, as the effective registry would answer it. */
  function launcher(w, { ready = true, su = false } = {}) {
    const el = (attrs) => { const e = w.document.createElement('a'); Object.assign(e.dataset, attrs); return e; };
    const items = {
      cases: { sidebar: el({ tab: 'tabCases' }) },
      comms: { sidebar: el({ tab: 'tabComms' }) },
      moreFeatures: { sidebar: el({ tab: 'tabMore', tabAlso: 'tabSettings' }) },
      moreManuals: { more: el({}) },
      'firm:x': {},                                         // firm items have no element
    };
    if (su) items.adminDbConsole = { admin: el({}) };
    w.ycLauncher = {
      isReady: () => ready,
      effectiveRegistry: () => Object.keys(items).map((id) => ({ id })),
      elementsOf: (id) => items[id] || {},
    };
  }

  test.each([
    ['tabCases', { tab: 'tabCases', rest: '' }],
    ['tabCases~x', { tab: 'tabCases', rest: 'x' }],
    ['tabComms~a~b~c', { tab: 'tabComms', rest: 'a~b~c' }],
    ['tabComms~x"><b>', { tab: 'tabComms', rest: '' }],     // invalid rest dropped, tab kept
    ['tabSettings', { tab: 'tabSettings', rest: '' }],       // via data-tab-also
    ['tabMore', { tab: 'tabMore', rest: '' }],               // via a More tile
    ['tabAll', { tab: 'tabAll', rest: '' }],
    ['tabHome', { tab: 'tabHome', rest: '' }],
    ['tabAdmin', { tab: 'tabHome', rest: '' }],              // non-SU
    ['tabAdmin~x', { tab: 'tabHome', rest: '' }],
    ['file-div2', { tab: 'tabHome', rest: '' }],             // a .file
    ['sbAdmin', { tab: 'tabHome', rest: '' }],               // not a .tab-main
    ['automationsDiv', { tab: 'tabHome', rest: '' }],
    ['nope', { tab: 'tabHome', rest: '' }],
    ['', { tab: 'tabHome', rest: '' }],
    ['file:1', { file: 1 }],
    ['file:1~tasks', { file: 1 }],                           // a file's rest lives in ?files=
  ])('non-SU: %j → %j', (open, want) => {
    const { w } = shell();
    launcher(w);
    expect(JSON.parse(JSON.stringify(w.wsOpenTarget(open)))).toEqual(want);
  });

  test('SU: tabAdmin allowed', () => {
    const { w } = shell();
    launcher(w, { su: true });
    expect(w.wsOpenTarget('tabAdmin~x').tab).toBe('tabAdmin');
  });

  test('launcher not ready → Home for everything but Home', () => {
    const { w } = shell();
    launcher(w, { ready: false, su: true });
    for (const t of ['tabCases', 'tabAll', 'tabAdmin', 'tabMore']) expect(w.wsOpenTarget(t).tab).toBe('tabHome');
    delete w.ycLauncher;
    expect(w.wsOpenTarget('tabCases').tab).toBe('tabHome');
  });
});

describe('addFile with a multi-segment rest (real addFile)', () => {
  function addFileWindow(withModule) {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="tabOpenFiles"></div><div id="sbOpenFiles"></div></body></html>',
      { url: 'https://app.4lsg.com/', runScripts: 'outside-only' });
    const w = dom.window;
    if (withModule) w.eval(MODULE);
    w.eval(`
      var fileCounter = 1;
      function E(id) { return document.getElementById(id); }
      function updateOpenFilesUI() {} function openMainTab() {}
      var Toast = { fire() {} };
      ${fnSrc(SHELL, 'ycSubTabOk')}
      ${fnSrc(SHELL, 'addFile')}
    `);
    return w;
  }

  test('first segment into the src, the full rest into the token and held for take()', () => {
    const w = addFileWindow(true);
    w.addFile('n', 'case', 'ABCD2345&tab=documents~x~y');
    const f = w.document.querySelector('#file-div1 > iframe');
    expect(new w.URL(f.getAttribute('src'), 'https://app.4lsg.com/').searchParams.get('tab')).toBe('documents');
    expect(w.document.getElementById('file-button1').dataset.fileSpec).toBe('cABCD2345~documents~x~y');
    expect(w.ycSubTab.host.take(f)).toBe('documents~x~y');
  });

  test('an invalid rest is dropped whole; without the module, only one plain segment passes', () => {
    const w = addFileWindow(true);
    w.addFile('n', 'case', 'ABCD2345&tab=documents~a~b~c~d');      // depth 5
    expect(w.document.getElementById('file-button1').dataset.fileSpec).toBe('cABCD2345');
    const bare = addFileWindow(false);
    bare.addFile('n', 'case', 'ABCD2345&tab=documents~x');
    bare.addFile('n', 'client', '1405&tab=documents');
    expect(bare.document.getElementById('file-button1').dataset.fileSpec).toBe('cABCD2345');
    expect(bare.document.getElementById('file-button2').dataset.fileSpec).toBe('p1405~documents');
  });
});

describe('the shipped shell loads ycSubTab.js before anything can call addFile', () => {
  // addFile's multi-segment path needs window.ycSubTab; without it addFile
  // falls back to S0's single-segment rule, silently. So the module is a
  // plain, synchronous <script src> parsed BEFORE the block that defines
  // addFile / the boot (loadUserContext) and every row render that links a file.
  test('a synchronous include, before addFile, loadUserContext and quickPick', () => {
    const tag = /<script\s+src="\/js\/ycSubTab\.js"\s*><\/script>/.exec(SHELL);
    expect(tag).not.toBeNull();
    for (const fn of ['function addFile(', 'async function loadUserContext(', 'async function quickPick(',
      'function restoreOpenFiles(', 'function tabCasesGet(']) {
      const at = SHELL.indexOf(fn);
      expect([fn, at > tag.index]).toEqual([fn, true]);
    }
    // and it is the only include of it (no second, later copy to shadow it)
    expect(SHELL.match(/<script[^>]*\/js\/ycSubTab\.js/g)).toHaveLength(1);
  });
});

describe('shell restore parse and openMainTabOnBoot', () => {
  test('restoreOpenFiles keeps the file when its rest is invalid', () => {
    const src = fnSrc(SHELL, 'restoreOpenFiles');
    const dom = new JSDOM('', { runScripts: 'outside-only' });
    dom.window.eval(MODULE);
    // just the token loop, as shipped
    const loop = src.slice(src.indexOf('const want = [];'), src.indexOf('if (!want.length) return;'));
    dom.window.eval(`function parseFiles(spec) { ${loop} return want; }`);
    const got = dom.window.parseFiles('cABCD2345~documents~x~y,p1405~a~b~c~d~e,cZZ_-9~x"><b>,b7,c-ok~~z');
    expect(JSON.parse(JSON.stringify(got.map((f) => [f.kind + f.id, f.sub])))).toEqual([
      ['cABCD2345', 'documents~x~y'], ['p1405', ''], ['cZZ_-9', ''], ['b7', ''], ['c-ok', ''],
    ]);
  });

  test('a rest is held for the tab\'s own pane; the opener still runs once', () => {
    const { w, $ } = shell();
    const calls = [];
    w.eval(`
      function openCasesTab() { __c.push('cases'); }
      function openContactsTab() {} function openApptsTab() {} function openCalendarTab() {}
      function openEventsTab() {} function openLogsTab() {}
      function openMainTab(t) { __c.push('main:' + t); }
      ${fnSrc(SHELL, 'openMainTabOnBoot')}
    `.replace(/__c/g, '__calls'));
    w.__calls = calls;
    w.openMainTabOnBoot('tabComms', 'phone~a');
    expect(w.__ws.main).toEqual({ tabComms: 'phone~a' });
    expect(w.ycTakeSubTab($('commsFrame'))).toBe('phone~a');
    w.openMainTabOnBoot('tabCases', 'x');                    // no pane: dropped
    expect(w.__ws.main).toEqual({ tabComms: 'phone~a' });
    expect(calls).toEqual(['main:tabComms', 'cases']);
  });
});
