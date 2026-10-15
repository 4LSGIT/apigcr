/**
 * wsurl S1b — case.html and contact.html report and restore their inner tab.
 *
 * Each page runs here as REAL code, in a REAL frame: the page's own markup
 * (scripts stripped, as tests/caseUi.sync.test.js does) loaded into a jsdom
 * iframe under a stub shell window, plus the page's own openTab and its
 * "Workspace URL" functions extracted from the shipped HTML (the fnSrc
 * pattern of tests/unifiedEventsU9.shell.test.js) and the real
 * public/js/ycSubTab.js. The buttons' inline onclick handlers run as shipped;
 * only their collaborators (E, caseID, ctEnter, …) are stubbed.
 *
 * The shell side of the contract (ycReportSubTab / ycTakeSubTab) is S1a's,
 * tested in tests/wsurlS1a.test.js; boot in the real shell is
 * scripts/mobile-survey/wsurl.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODULE = read('public/js/ycSubTab.js');
const PAGES = { case: read('public/case.html'), contact: read('public/contact.html') };

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

const pick = (src, re) => { const m = re.exec(src); if (!m) throw new Error('not found: ' + re); return m[0]; };

/** Every <button> with class "tab", parsed (by a real parser — an onclick
 *  can hold markup, e.g. Refresh's '<p>…') from the shipped markup. */
function tabButtons(html) {
  const doc = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, '')).window.document;
  return [...doc.querySelectorAll('button.tab')].map((b) => {
    const onclick = b.getAttribute('onclick') || '';
    const target = /openTab\(this,\s*'([^']+)'\)/.exec(onclick);
    return { ws: b.getAttribute('data-ws-tab'), id: b.id || null, target: target ? target[1] : null, onclick };
  });
}

// The vocabulary, pinned: content id → token, per page (the S1b inventory).
const VOCAB = {
  case: {
    tabOverview: 'overview', tabClients: 'clients', tabAppts: 'appts', tabEvents: 'events',
    tabTimeline: 'timeline', checklists: 'checklists', tabTasks: 'tasks', tabDB: 'db',
    tabDocuments: 'documents', tabForms: 'forms', tabEsign: 'esign', tabAuto: 'auto', tabLog: 'log',
    tabInfo: 'ISSN', tabSend: 'send', tabCase: 'case', tab341: '341', tabDet: 'det',
  },
  contact: {
    tabInfo: 'info', tabRels: 'rels', tabSend: 'send', tabTasks: 'tasks', tabNotes: 'notes',
    tabAppts: 'appts', tabEvents: 'events', tabCases: 'cases', tabBills: 'bills',
    tabDocuments: 'documents', tabSeq: 'auto', tabLog: 'log',
  },
};
const DEFAULT = { case: 'tabOverview', contact: 'tabInfo' };

describe.each(['case', 'contact'])('%s.html — the tab button inventory', (page) => {
  const html = PAGES[page];
  const buttons = tabButtons(html);

  test('every .tab button is a tab with a token, or the Refresh button (no target, reloads)', () => {
    for (const b of buttons) {
      if (b.target) expect([b.target, b.ws]).toEqual([b.target, VOCAB[page][b.target]]);
      else {
        expect(b.ws).toBeNull();
        expect(b.onclick).toContain('location.reload()');
      }
    }
    expect(buttons.filter((b) => !b.target)).toHaveLength(1);
    // every content id in the vocabulary has a button, and no button is untokened
    expect([...new Set(buttons.filter((b) => b.target).map((b) => b.target))].sort())
      .toEqual(Object.keys(VOCAB[page]).sort());
  });

  test('tokens are vocabulary [A-Za-z0-9_-]{1,32}, one per content id, unique per row', () => {
    const toks = Object.values(VOCAB[page]);
    toks.forEach((t) => expect(t).toMatch(/^[A-Za-z0-9_-]{1,32}$/));
    expect(new Set(toks).size).toBe(toks.length);
    const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ''));
    for (const row of dom.window.document.querySelectorAll('.tab-row')) {
      const t = [...row.querySelectorAll('button.tab[data-ws-tab]')].map((b) => b.dataset.wsTab);
      expect(new Set(t).size).toBe(t.length);
    }
    // never `data-tab` (other meanings elsewhere)
    expect(html).not.toMatch(/<button[^>]*\bdata-tab=/);
  });

  test('legacy <x>Button ids are kept, and their prefix IS the token', () => {
    const withId = buttons.filter((b) => b.target && b.id && /Button$/.test(b.id));
    expect(withId.length).toBeGreaterThan(0);
    for (const b of withId) expect([b.id, b.ws]).toEqual([b.id, b.id.replace(/Button$/, '')]);
  });

  test('the page loads /js/ycSubTab.js', () => {
    expect(html).toMatch(/<script src="\/js\/ycSubTab\.js"><\/script>/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * The page inside a real frame of a stub shell. Returns the shell window,
 * the page window, and the shell's record of what the page reported.
 */
function framed(page, { held = null } = {}) {
  const src = PAGES[page];
  const shell = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
  const frame = shell.document.createElement('iframe');
  shell.document.body.appendChild(frame);
  const w = frame.contentWindow;
  const reports = [];
  let pending = held;
  shell.ycReportSubTab = (f, r) => reports.push([f === frame, r]);
  shell.ycTakeSubTab = (f) => { const r = f === frame ? pending : null; pending = null; return r; };

  w.document.body.innerHTML = src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/^[\s\S]*<body[^>]*>/, '').replace(/<\/body>[\s\S]*$/, '');
  // contact.html's tab strip lives in #tabViewClient, which its boot shows
  // just before the restore; case.html's #tabButtons is shown likewise.
  for (const id of ['tabViewClient', 'tabButtons']) {
    const el = w.document.getElementById(id);
    if (el) el.style.display = 'block';
  }
  w.eval(MODULE);
  w.eval(`
    var E = (id) => document.getElementById(id);
    var caseID = 'ABCD2345', clientID = '1405', events = [1];
    function ctEnter() {} function refreshEvents() {} function loadContactRelations() {}
    ${page === 'case' ? 'var tab = "";' : ''}
    ${fnSrc(src, 'openTab')}
    ${pick(src, /var WS_DEFAULT_TAB = "[A-Za-z]+";/)}
    var wsTabMap = null;
    ${['wsTargetOf', 'wsTokenFor', 'wsReportTab', 'wsShown', 'wsButtonFor', 'wsShownTab',
      'wsResolve', 'wsRestoreTab', 'wsBootRest'].map((n) => fnSrc(src, n)).join('\n')}
    ${assignedFnSrc(src, 'ycApplySubTab')}
  `);
  const shown = () => w.wsShownTab();
  const btn = (tok) => [...w.document.querySelectorAll('button.tab[data-ws-tab]')].filter((b) => b.dataset.wsTab === tok);
  return { shell, w, reports, shown, btn, frame };
}

describe.each(['case', 'contact'])('%s.html — openTab reports', (page) => {
  test('a click on every tab reports its token; the default tab reports ""', () => {
    const { w, reports } = framed(page);
    if (page === 'case') w.document.getElementById('bkButtons').style.display = '';
    for (const b of w.document.querySelectorAll('button.tab[data-ws-tab]')) {
      reports.length = 0;
      b.click();
      const want = w.wsTargetOf(b) === DEFAULT[page] ? '' : b.dataset.wsTab;
      expect([b.dataset.wsTab, reports]).toEqual([b.dataset.wsTab, [[true, want]]]);
    }
  });

  test('a programmatic openTab(null, id) reports through the content-id map', () => {
    const { w, reports } = framed(page);
    w.openTab(null, 'tabDocuments');
    w.openTab(null, DEFAULT[page]);
    expect(reports).toEqual([[true, 'documents'], [true, '']]);
  });

  test('unframed: nothing is reported, nothing throws', () => {
    const dom = new JSDOM(PAGES[page].replace(/<script[\s\S]*?<\/script>/g, ''),
      { url: 'https://app.4lsg.com/x.html', runScripts: 'outside-only' });
    const w = dom.window;
    w.eval(MODULE);
    let called = 0;
    w.ycReportSubTab = () => { called++; };
    w.eval(`var E = (id) => document.getElementById(id); function loadContactRelations() {}
      ${fnSrc(PAGES[page], 'openTab')} var WS_DEFAULT_TAB = "${DEFAULT[page]}"; var wsTabMap = null;
      ${fnSrc(PAGES[page], 'wsTargetOf')} ${fnSrc(PAGES[page], 'wsTokenFor')} ${fnSrc(PAGES[page], 'wsReportTab')}`);
    expect(() => w.openTab(null, 'tabDocuments')).not.toThrow();
    expect(called).toBe(0);
  });
});

describe.each(['case', 'contact'])('%s.html — restore and apply', (page) => {
  test('restore: a held token is clicked; an unknown one falls back to the default', () => {
    for (const [rest, want] of [['documents', 'tabDocuments'], ['documents~x~y', 'tabDocuments'],
      ['tasks', 'tabTasks'], ['bogus', DEFAULT[page]], ['', DEFAULT[page]], [null, DEFAULT[page]],
      ['x"><img id=pwn>', DEFAULT[page]], ['tabDocuments', DEFAULT[page]]]) {   // a content id is not a token
      const { w, shown } = framed(page);
      expect(() => w.wsRestoreTab(rest)).not.toThrow();
      expect([rest, shown()]).toEqual([rest, want]);
      expect(w.document.getElementById('pwn')).toBeNull();
    }
  });

  test('boot takes the shell\'s held rest ONCE, and it wins over a legacy ?tab=', () => {
    const { w, shell } = framed(page, { held: 'documents~x' });
    if (page === 'case') w.tab = 'tasks';
    expect(w.wsBootRest()).toBe('documents~x');
    expect(w.wsBootRest()).toBe(page === 'case' ? 'tasks' : '');   // taken; now the legacy value
    expect(shell).toBeTruthy();
  });

  test('apply: the tab already shown is a NO-OP (no click → no reload on top of the refresh)', () => {
    const { w, shown, btn } = framed(page);
    w.wsRestoreTab('documents');
    let clicks = 0;
    for (const b of w.document.querySelectorAll('button.tab')) b.addEventListener('click', () => { clicks++; });
    w.ycApplySubTab('documents');
    w.ycApplySubTab('documents~other');
    expect(clicks).toBe(0);
    w.ycApplySubTab('tasks');
    expect([clicks, shown()]).toEqual([1, 'tabTasks']);
    w.ycApplySubTab('');                        // → the default
    expect([clicks, shown()]).toEqual([2, DEFAULT[page]]);
    w.ycApplySubTab('bogus');                   // default already shown: no-op
    expect(clicks).toBe(2);
    expect(btn('documents')).toHaveLength(1);
  });
});

describe('case.html — type rows', () => {
  test('a token whose button sits in a HIDDEN type row falls back (~ISSN on a non-BK case)', () => {
    const { w, shown } = framed('case');
    w.document.getElementById('bkButtons').style.display = 'none';
    w.document.getElementById('otherButtons').style.display = '';
    w.wsRestoreTab('ISSN');
    expect(shown()).toBe('tabOverview');
    w.wsRestoreTab('341');
    expect(shown()).toBe('tabOverview');
  });

  test('send / case resolve to the button in the DISPLAYED row', () => {
    for (const row of ['bkButtons', 'otherButtons']) {
      const { w, shown } = framed('case');
      w.document.getElementById('bkButtons').style.display = row === 'bkButtons' ? '' : 'none';
      w.document.getElementById('otherButtons').style.display = row === 'otherButtons' ? '' : 'none';
      let clickedIn = null;
      for (const b of w.document.querySelectorAll('button.tab[data-ws-tab="send"]')) {
        b.addEventListener('click', () => { clickedIn = b.closest('.tab-row').id; });
      }
      w.wsRestoreTab('send');
      expect([row, shown(), clickedIn]).toEqual([row, 'tabSend', row]);
    }
  });

  test('on a BK case, ~ISSN restores the Initial Strategy Session tab', () => {
    const { w, shown } = framed('case');
    w.document.getElementById('bkButtons').style.display = '';
    w.wsRestoreTab('ISSN');
    expect(shown()).toBe('tabInfo');
  });
});

describe('the boot order, as shipped', () => {
  test('case.html restores AFTER loadIframes (applyCaseType) and BEFORE tabLogGet; the old crash path is gone', () => {
    const src = PAGES.case;
    const boot = src.slice(src.indexOf('// ── Initial load'), src.indexOf('/* ── Sync bus subscriber'));
    const at = (n) => { const i = boot.indexOf(n); expect([n, i >= 0]).toEqual([n, true]); return i; };
    expect(at('wsRest = wsBootRest();') < at('loadIframes();')).toBe(true);   // taken once, before anything can throw
    expect(at('loadIframes();') < at('wsRestoreTab(wsRest);')).toBe(true);
    expect(at('wsRestoreTab(wsRest);') < at('tabLogGet(0);')).toBe(true);
    expect(boot).not.toMatch(/E\(`\$\{tab\}Button`\)\.click\(\)/);
    // a failure after the strip is up still restores a tab, from the same rest
    const c = boot.slice(boot.indexOf('} catch (err) {'));
    expect(c).toContain('if (E("tabButtons").style.display === "block" && !wsShownTab()) wsRestoreTab(wsRest);');
    expect(boot.match(/wsBootRest\(\)/g)).toHaveLength(1);
  });

  test('contact.html restores where it used to open Client Information', () => {
    const src = PAGES.contact;
    const boot = src.slice(src.indexOf('// ── Initial load'));
    expect(boot).toContain("E('tabViewClient').style.display = 'block';\n    wsRestoreTab(wsBootRest());");
    expect(boot).not.toContain("openTab(null, 'tabInfo');");
  });
});
