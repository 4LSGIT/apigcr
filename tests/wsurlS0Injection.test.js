/**
 * wsurl S0 — the shell's file-open path must not turn data into markup.
 *
 * A link like /?case=<any term>,"></iframe><img onerror=…> used to reach the
 * shell DOM: boot hands the text after the comma to quickPick() as the
 * sub-tab, quickPick appended it to the id, and addFile() wrote
 * `<iframe src="/case.html?caseID=${fileID}…">` through innerHTML. The
 * search runs with limit=1, so ANY term with a hit got there. The search
 * picker and the file button's label had the same shape of sink (r.name,
 * r.detail and the tab quoted into onclick source; fileName into innerHTML).
 *
 * These tests run the REAL ycSubTabOk / addFile / quickPick /
 * showSearchPicker source extracted from public/index.html, in jsdom. Only
 * their collaborators are stubbed (apiSend, Swal, Toast, openMainTab, the
 * sidebar refresh). The DOM-shape test pins the markup a valid open
 * produced before the fix, byte for byte.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SHELL = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Same extractor as tests/unifiedEventsU9.shell.test.js.
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

const UNDER_TEST = ['ycSubTabOk', 'addFile', 'quickPick', 'showSearchPicker']
  .map((n) => fnSrc(SHELL, n)).join('\n');

function boot(results = []) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="tabOpenFiles"></div><div id="sbOpenFiles"></div></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'outside-only' }
  );
  const w = dom.window;
  const rec = { swal: [], toast: [], opened: [], closed: 0 };
  w.__rec = rec;
  w.__results = results;
  w.eval(`
    var fileCounter = 1;
    function E(id) { return document.getElementById(id); }
    function updateOpenFilesUI() {}
    function openMainTab(id) { __rec.opened.push(id); }
    function showProcessingSwal() {}
    function fmtCaseType() { return ''; }
    async function apiSend() { return { results: __results }; }
    var Toast = { fire: function (o) { __rec.toast.push(o); return Promise.resolve({}); } };
    var Swal = {
      fire: function (o) {
        __rec.swal.push(o);
        // The real Swal appends an element passed as html; mirror that so
        // the rows can be inspected and clicked.
        if (o && o.html && o.html.nodeType) document.body.appendChild(o.html);
        return Promise.resolve({ isConfirmed: false });
      },
      close: function () { __rec.closed++; },
    };
    ${UNDER_TEST}
  `);
  const $ = (sel) => w.document.querySelector(sel);
  const srcOf = (divId) => {
    const f = w.document.querySelectorAll(`#${divId} > iframe`);
    expect(f).toHaveLength(1);
    return new URL(f[0].getAttribute('src'), 'https://app.4lsg.com/');
  };
  return { w, rec, $, srcOf };
}

const CASE_HIT = [{ type: 'case', id: 'ABCD2345', name: 'Some Case' }];
const PAYLOAD = 'x"></iframe><img id=pwn src=x>';

describe('wsurl S0 — ?case= / ?contact= sub-tab', () => {
  test('?case= path: an injected tab is dropped, the file opens on its default tab', async () => {
    const { w, rec, $, srcOf } = boot(CASE_HIT);
    await w.quickPick('x', 'case', PAYLOAD);
    expect($('#pwn')).toBeNull();
    const src = srcOf('file-div1');
    expect(src.pathname).toBe('/case.html');
    expect(src.searchParams.get('caseID')).toBe('ABCD2345');
    expect(src.searchParams.has('tab')).toBe(false);
    expect($('#file-button1 span').textContent).toBe('Some Case');
    expect($('#file-button1').dataset.fileSpec).toBe('cABCD2345');
    expect(rec.opened).toContain('file-div1');
  });

  test('?contact= path: same, and a hostile NAME is shown as text', async () => {
    const name = '<b id=pwnC>Ann</b>';
    const { w, rec, $, srcOf } = boot([{ type: 'contact', id: 1405, name }]);
    await w.quickPick('1405', 'contact', PAYLOAD);
    expect($('#pwn')).toBeNull();
    expect($('#pwnC')).toBeNull();
    const src = srcOf('file-div1');
    expect(src.pathname).toBe('/contact.html');
    expect(src.searchParams.get('clientID')).toBe('1405');
    expect(src.searchParams.has('tab')).toBe(false);
    expect($('#file-button1 span').textContent).toBe(name);
    expect($('#file-button1').dataset.fileSpec).toBe('p1405');
    // the "Opening: …" toast is plain text, not HTML
    const t = rec.toast.find((o) => o.icon === 'success');
    expect(t.titleText).toBe(`Opening: ${name}`);
    expect(t.title).toBeUndefined();
  });

  test('a valid tab survives into the src and the restore token', async () => {
    const { w, $, srcOf } = boot(CASE_HIT);
    await w.quickPick('x', 'case', 'documents');
    expect(srcOf('file-div1').searchParams.get('tab')).toBe('documents');
    expect($('#file-button1').dataset.fileSpec).toBe('cABCD2345~documents');
  });

  test('a tab that is not a plain token is dropped WHOLE, never salvaged', async () => {
    // 'documents&fileCount=9' would otherwise split into a valid tab=documents.
    const { w, $, srcOf } = boot(CASE_HIT);
    await w.quickPick('x', 'case', 'documents&fileCount=9');
    const src = srcOf('file-div1');
    expect(src.searchParams.has('tab')).toBe(false);
    expect(src.searchParams.get('fileCount')).toBe('1');
    expect($('#file-button1').dataset.fileSpec).toBe('cABCD2345');
  });
});

describe('wsurl S0 — addFile itself (every caller, not just quickPick)', () => {
  test('an injected tab= value in fileID never reaches the DOM or the token', () => {
    const { w, $, srcOf } = boot();
    w.addFile('n', 'case', 'ABCD2345&tab=x"></iframe><img id=pwn3 src=x>');
    expect($('#pwn3')).toBeNull();
    expect(srcOf('file-div1').searchParams.has('tab')).toBe(false);
    expect($('#file-button1').dataset.fileSpec).toBe('cABCD2345');
  });

  test('an id that is not the id shape is refused: no file, no src', () => {
    const { w, rec, $ } = boot();
    expect(w.addFile('n', 'case', '"><img id=pwn4 src=x>')).toBeNull();
    expect(w.addFile('n', 'client', '"><img id=pwn5 src=x>')).toBeNull();
    expect($('#pwn4')).toBeNull();
    expect($('#pwn5')).toBeNull();
    expect(w.document.querySelectorAll('.file-button, .tab-main.file')).toHaveLength(0);
    expect(rec.toast.filter((o) => o.icon === 'error')).toHaveLength(2);
  });

  test('a hostile label is text, in the button and in the close confirm', async () => {
    const name = '<img id=pwnL src=x>';
    const { w, rec, $ } = boot();
    w.addFile(name, 'case', 'ABCD2345');
    expect($('#pwnL')).toBeNull();
    expect($('#file-button1 span').textContent).toBe(name);
    $('#file-button1 .file-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const confirm = rec.swal[rec.swal.length - 1];
    expect(confirm.titleText).toBe(`Close "${name}"?`);
    expect(confirm.title).toBeUndefined();
  });

  test('DOM shape of valid opens is unchanged (pinned from the pre-fix code)', () => {
    const { w } = boot();
    const ret = [
      w.addFile('Smith & Jones', 'case', 'ABCD2345&tab=documents'),
      w.addFile('Ann', 'client', '1405'),
      w.addFile('Bo', 'contact', '77&tab=tasks'),
      w.addFile('Bill 9', 'bill', '9'),
    ];
    expect(ret).toEqual(['file-div1', 'file-div2', 'file-div3', 'file-div4']);
    expect(w.document.getElementById('tabOpenFiles').innerHTML).toBe(
      '<div class="file-button" id="file-button1" data-file-id="file-div1" title="Smith &amp; Jones" data-file-spec="cABCD2345~documents"><i class="fa-solid fa-landmark"></i><span>Smith &amp; Jones</span><i class="file-close fa-solid fa-circle-xmark"></i></div>'
      + '<div class="file-button" id="file-button2" data-file-id="file-div2" title="Ann" data-file-spec="p1405"><i class="fa-solid fa-user"></i><span>Ann</span><i class="file-close fa-solid fa-circle-xmark"></i></div>'
      + '<div class="file-button" id="file-button3" data-file-id="file-div3" title="Bo" data-file-spec="p77~tasks"><i class="fa-solid fa-user"></i><span>Bo</span><i class="file-close fa-solid fa-circle-xmark"></i></div>'
      + '<div class="file-button" id="file-button4" data-file-id="file-div4" title="Bill 9" data-file-spec="b9"><i class="fa-solid fa-file-invoice-dollar"></i><span>Bill 9</span><i class="file-close fa-solid fa-circle-xmark"></i></div>'
    );
    expect([...w.document.querySelectorAll('.tab-main.file')].map((d) => d.outerHTML)).toEqual([
      '<div class="tab-main file" id="file-div1"><iframe src="/case.html?caseID=ABCD2345&amp;tab=documents&amp;fileCount=1"></iframe></div>',
      '<div class="tab-main file" id="file-div2"><iframe src="/contact.html?clientID=1405&amp;fileCount=2"></iframe></div>',
      '<div class="tab-main file" id="file-div3"><iframe src="/contact.html?clientID=77&amp;tab=tasks&amp;fileCount=3"></iframe></div>',
      '<div class="tab-main file" id="file-div4"><h1>No bills today!</h1><p>file Count: 4</p></div>',
    ]);
  });
});

describe('wsurl S0 — the search picker', () => {
  const HITS = [
    { type: 'contact', id: 1405, name: '<img id=pwn2 src=x>', detail: '<i id=pwnD>313</i>' },
    { type: 'case', id: 'ABCD2345', name: 'Case X' },
  ];

  test('names and details render literally; a click opens the file, tab dropped', async () => {
    const { w, rec, $ } = boot(HITS);
    await w.quickPick('x', null, "o'x", 10);
    expect($('#pwn2')).toBeNull();
    expect($('#pwnD')).toBeNull();
    const rows = w.document.querySelectorAll('.qp-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('b').textContent).toBe(HITS[0].name);
    expect(rows[0].textContent).toContain(HITS[0].detail);
    expect(rows[0].hasAttribute('onclick')).toBe(false);
    const closedBefore = rec.closed;   // quickPick closes its processing Swal too
    rows[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(rec.closed).toBe(closedBefore + 1);
    expect($('#pwn2')).toBeNull();
    expect($('#file-button1 span').textContent).toBe(HITS[0].name);
    expect($('#file-button1').dataset.fileSpec).toBe('p1405');
  });

  test('the picker drops a non-token tab whole, and carries a valid one', () => {
    for (const [tab, spec] of [['documents&x=1', 'cABCD2345'], ['documents', 'cABCD2345~documents']]) {
      const { w, $ } = boot();
      w.showSearchPicker(HITS, tab);
      w.document.querySelectorAll('.qp-row')[1].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      expect($('#file-button1').dataset.fileSpec).toBe(spec);
    }
  });
});
