/**
 * wsurl S0b — file-open links built from stored free text.
 *
 * Case/contact links used to be HTML strings like
 *   <a href="#" onclick="addFile('${name}','case','${id}')">${name}</a>
 * with the name escaped for `'` only (or not at all), and the visible text
 * inserted raw. A `"` broke out of the attribute, a `\` out of the JS
 * string, and a `<` straight into the page — in the shell's own document,
 * which holds apiSend. Names and dockets reach these from intake.
 *
 * Now: scripts.js's fileLinkHtml() puts every value through escAttr/escText
 * into data-* attributes, and one capture-phase listener per document calls
 * addFile(label, kind, id) with the raw values. apptform2.html (no
 * scripts.js) builds its links as DOM. tasks.html and esign/dashboard.html
 * keep their own openers (openLinked / openLinkable), fed from data-*
 * attributes by their own delegated listeners.
 *
 * Everything here runs REAL code: the whole of public/scripts.js, and the
 * page functions extracted from the shipped HTML (the fnSrc pattern of
 * tests/unifiedEventsU9.shell.test.js). Only collaborators are stubbed:
 * apiSend, Swal, addFile, and a page's own unrelated helpers.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const ESIGN_ACTIONS = read('public/esign/esignActions.js');

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

/** A top-level statement block, from its leading comment to `}, true);`. */
function blockSrc(src, startMarker) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error(`block "${startMarker}" not found`);
  const end = src.indexOf('}, true);', i);
  return src.slice(i, end + '}, true);'.length);
}

// The payloads. HOSTILE carries every breakout character at once.
const HOSTILE = 'a"b\\c\'d<img id=pwn src=x>';
const AMP = 'x&quot;);window.__pwn=1;//';          // broke the old calx anchor
const TASK_TITLE = "\\';window.__pwn=1;//";         // broke tasks.html's JS string
const QUOTE_LABEL = 'Ann "the client" <img id=pwn src=x>';

const SWAL_STUB = `
  window.Swal = {
    mixin: () => ({ fire: () => Promise.resolve({}) }),
    fire: () => Promise.resolve({ isConfirmed: false }),
    close() {}, showLoading() {}, update() {},
  };`;

/** A window with the REAL scripts.js, as a shell-side document: the global
 *  addFile is the spy (that is what _resolveAddFile finds first). */
function shellDoc(extra = '', body = '') {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${body}</body></html>`,
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = dom.window;
  w.__calls = [];
  w.addFile = (...args) => { w.__calls.push(args); };
  // One eval: separate <script> tags share one global lexical environment,
  // which an indirect eval per file would not (see tests/caseUi.sync.test.js).
  w.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + extra);
  return w;
}

const click = (w, el) => {
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
};

describe('wsurl S0b — fileLinkHtml + its delegated listener (real scripts.js)', () => {
  test('a hostile label renders literally and reaches addFile raw', () => {
    const w = shellDoc();
    w.document.body.innerHTML = w.fileLinkHtml(HOSTILE, 'case', 'ABCD2345', HOSTILE, HOSTILE);
    expect(w.document.getElementById('pwn')).toBeNull();
    const a = w.document.querySelector('a.yc-file-link');
    expect(a.textContent).toBe(HOSTILE);
    expect(a.title).toBe(HOSTILE);
    expect(a.hasAttribute('onclick')).toBe(false);
    const ev = click(w, a);
    expect(ev.defaultPrevented).toBe(true);
    expect(w.__calls).toEqual([[HOSTILE, 'case', 'ABCD2345']]);
  });

  test('ordinary data: the exact markup', () => {
    const w = shellDoc();
    expect(w.fileLinkHtml('25-12345', 'case', 'ABCD2345', '25-12345'))
      .toBe('<a href="#" class="yc-file-link" data-file-kind="case" data-file-id="ABCD2345" data-file-label="25-12345">25-12345</a>');
    expect(w.fileLinkHtml('25-12345', 'case', 'ABCD2345', '25-12345', 'ABCD2345'))
      .toBe('<a href="#" class="yc-file-link" title="ABCD2345" data-file-kind="case" data-file-id="ABCD2345" data-file-label="25-12345">25-12345</a>');
  });

  test('capture phase: a row handler that stops propagation cannot swallow the click', () => {
    const w = shellDoc();
    w.document.body.innerHTML = `<div id="row">${w.fileLinkHtml('Ann', 'client', '1405', 'Ann')}</div>`;
    w.document.getElementById('row').addEventListener('click', (e) => e.stopPropagation());
    click(w, w.document.querySelector('a.yc-file-link'));
    expect(w.__calls).toEqual([['Ann', 'client', '1405']]);
  });
});

describe('wsurl S0b — index.html (calxAnchor)', () => {
  const SHELL = read('public/index.html');
  const src = fnSrc(SHELL, 'calxEsc') + '\n' + fnSrc(SHELL, 'calxAnchor');

  test.each([['HOSTILE', HOSTILE], ['&quot; payload', AMP]])(
    'contact and case anchors with a %s name', (_, name) => {
      const w = shellDoc(src);
      w.document.body.innerHTML =
        w.calxAnchor({ link_type: 'contact', link_id: 1405, display: { contact_name: name } }) +
        w.calxAnchor({ link_type: 'case', case_id: 'ABCD2345', display: { case_label: name } });
      expect(w.document.getElementById('pwn')).toBeNull();
      const links = w.document.querySelectorAll('a');
      expect(links).toHaveLength(2);
      links.forEach((a) => { expect(a.textContent).toBe(name); click(w, a); });
      expect(w.__pwn).toBeUndefined();
      expect(w.__calls).toEqual([[name, 'client', '1405'], [name, 'case', 'ABCD2345']]);
    });
});

/** case.html / contact.html log cell, through the page's REAL tabLogGet. */
async function bootLog(page) {
  const SRC = read(page);
  const w = shellDoc(`
    var limit = 100, logs = [];
    function getLogFilterParams() { return {}; }
    function exportLog() {}
    ${fnSrc(SRC, 'tabLogGet')}
  `, '<button id="tabLogButton"></button><div id="tabLogLoad"></div>'
   + '<table id="logTable"><tr><th>h</th></tr></table><div id="logTableFoot"></div>');
  // P is window.parent — in a top-level jsdom window, the window itself.
  w.apiSend = async () => ({
    total: 2,
    entries: [
      { log_id: 1, log_type: 'note', formatted_date: 'd', log_data: 'x',
        case_id: 'ABCD2345', log_link: 'ABCD2345', case_number: HOSTILE },
      { log_id: 2, log_type: 'note', formatted_date: 'd', log_data: 'x',
        contact_id: 1405, log_link: '1405', contact_name: QUOTE_LABEL },
    ],
  });
  await w.tabLogGet(0);
  return w;
}

describe.each(['public/case.html', 'public/contact.html'])('wsurl S0b — %s log cell', (page) => {
  test('hostile docket and name: no markup, raw labels on click', async () => {
    const w = await bootLog(page);
    expect(w.document.getElementById('pwn')).toBeNull();
    const links = w.document.querySelectorAll('#logTable a.yc-file-link');
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe(HOSTILE);
    expect(links[1].textContent).toBe(QUOTE_LABEL);
    links.forEach((a) => click(w, a));
    expect(w.__calls).toEqual([[HOSTILE, 'case', 'ABCD2345'], [QUOTE_LABEL, 'client', '1405']]);
  });
});

describe('wsurl S0b — apptform2.html (renderCase, DOM; no scripts.js there)', () => {
  const SRC = read('public/apptform2.html');

  test('a hostile docket is text in both links; each opens with the raw label', () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="caseDisplay"></div>'
      + '<div id="addCasePanel"></div><div id="caseInfo"></div></body></html>',
      { url: 'https://app.4lsg.com/apptform2.html', runScripts: 'dangerously' });
    const w = dom.window;
    w.__calls = [];
    w.eval(`
      var P = { addFile: (...a) => window.__calls.push(a) };
      var apptData = { appt_case_id: 'ABCD2345', case_number_display: ${JSON.stringify(HOSTILE)} };
      function acFillCaseTypes() {}
      ${fnSrc(SRC, 'renderCase')}
      renderCase();
    `);
    expect(w.document.getElementById('pwn')).toBeNull();
    // same shape as the old template: <a>docket</a> <span>(id)</span>
    const d = w.document.getElementById('caseDisplay');
    expect([...d.childNodes].map((n) => n.nodeName)).toEqual(['A', '#text', 'SPAN']);
    expect(d.childNodes[1].textContent).toBe(' ');
    expect(d.querySelector('span').textContent).toBe('(ABCD2345)');
    const links = w.document.querySelectorAll('a');
    expect(links).toHaveLength(2);
    links.forEach((a) => { expect(a.textContent).toBe(HOSTILE); expect(a.getAttribute('href')).toBe('#'); click(w, a); });
    expect(w.__calls).toEqual([[HOSTILE, 'case', 'ABCD2345'], [HOSTILE, 'case', 'ABCD2345']]);
  });
});

describe('wsurl S0b — tasks.html linked-to cell (real page, both hosts)', () => {
  const HTML = read('public/tasks.html');
  const BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script>'));
  const INLINE = HTML.slice(HTML.indexOf('<script>') + 8, HTML.lastIndexOf('</script>'));
  const YCPAGER = read('public/js/ycPager.js');

  /** Boot tasks.html into `win`; the shell surface lives on win.top. */
  async function bootTasks(win, top, title) {
    top.__calls = [];
    top.apiSend = async (url, method) => (url === '/api/tasks' && method === 'GET'
      ? { data: [{ id: 1, title: 't', status: 'Pending', priority: 2, due: null,
        assigned_to: 6, assigned_by: 6, link: { id: 'ABCD2345', type: 'case', title } }], total: 1 }
      : { status: 'success' });
    top.firmData = { users: [{ user: 6, user_name: 'Fred Ross' }], firmTimezone: 'America/Detroit' };
    top.user = { user: 6, user_name: 'Fred Ross' };
    top.addFile = (...a) => { top.__calls.push(a); };
    win.document.body.innerHTML = BODY;
    win.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + YCPAGER + '\n' + INLINE);
    await new Promise((r) => win.setTimeout(r, 50));
  }

  async function check(win, top, title) {
    await bootTasks(win, top, title);
    expect(win.document.getElementById('pwn')).toBeNull();
    const a = win.document.querySelector('#tasksTable a.tk-linked');
    expect(a).not.toBeNull();
    expect(a.textContent).toBe(title);
    click(win, a);
    expect(win.__pwn).toBeUndefined();
    expect(top.__calls).toEqual([[title, 'case', 'ABCD2345']]);
  }

  test.each([['backslash', TASK_TITLE], ['quote', QUOTE_LABEL]])(
    'directly under the shell (%s title)', async (_, title) => {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
        { url: 'https://app.4lsg.com/tasks.html', runScripts: 'dangerously' });
      await check(dom.window, dom.window, title);
    });

  test('nested shell → case.html → tasks.html: still reaches the shell', async () => {
    const shell = new JSDOM('<!DOCTYPE html><html><body></body></html>',
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
    const caseFrame = shell.document.createElement('iframe');
    shell.document.body.appendChild(caseFrame);
    const tasksFrame = caseFrame.contentWindow.document.createElement('iframe');
    caseFrame.contentWindow.document.body.appendChild(tasksFrame);
    const inner = tasksFrame.contentWindow;
    expect(inner.top).toBe(shell);
    expect(inner.parent).not.toBe(shell);
    await check(inner, shell, TASK_TITLE);
  });
});

describe('wsurl S0b — esign/dashboard.html case/contact cell', () => {
  const SRC = read('public/esign/dashboard.html');

  test.each([['backslash', TASK_TITLE], ['quote', QUOTE_LABEL]])(
    'a %s label: no markup, openLinkable gets the raw values', (_, label) => {
      const w = shellDoc(`
        ${ESIGN_ACTIONS}
        let filter = 'all', sortKey = 'days', sortDir = -1;
        let rows = [{ id: 7, linkable_type: 'contact', linkable_id: 1405, status: 'sent',
                      document_name: 'Retainer', kind: 'esign', recipients: [], days_pending: 2 }];
        const labelCache = new Map([['contact:1405', ${JSON.stringify(label)}]]);
        function sortedRows() { return rows; }
        ${fnSrc(SRC, 'render')}
        ${blockSrc(SRC, "// The case/contact cell's click.")}
        ${fnSrc(SRC, 'openLinkable')}
        render();
      `, '<span id="db-s-status"></span><span id="db-s-sent"></span><span id="db-s-days"></span>'
       + '<table id="db-table"><tr><th>h</th></tr></table><div id="db-empty"></div>');
      expect(w.document.getElementById('pwn')).toBeNull();
      const el = w.document.querySelector('#db-table .db-link');
      expect(el.hasAttribute('onclick')).toBe(false);
      expect(el.textContent.trim()).toBe(label);
      click(w, el);
      expect(w.__pwn).toBeUndefined();
      expect(w.__calls).toEqual([[label, 'contact', '1405']]);
    });
});
