/**
 * tests/caseCaption.casesTab.test.js
 *
 * The Cases tab's Caption control, on the real markup, CSS and page functions,
 * driven through the rendered control. Off has to read as the table did before
 * the column existed.
 *
 *   npx jest tests/caseCaption.casesTab.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const INDEX = read('public/index.html');
const CSS = read('public/style.css');
const SCRIPTS = read('public/scripts.js');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  const start = m.index;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

function slice(startMark, endMark) {
  const a = INDEX.indexOf(startMark);
  const b = INDEX.indexOf(endMark, a);
  if (a < 0 || b < 0) throw new Error(`markup not found: ${startMark}`);
  return INDEX.slice(a, b);
}

const CASES = [
  { case_id: 'ADVCASE1', case_number: '26-04202-mar', case_caption: 'Schneyer v. Childs', caption_adds_info: true,
    case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding', case_stage: 'Open', case_status: 'Active',
    open: 'Sep. 12, 2026', file: '', close: '',
    contacts: [{ contact_id: 1, contact_name: 'Jason F Childs', contact_relate: 'Primary' }] },
  { case_id: 'MAINCASE', case_number: '26-49875-lsg', case_caption: 'In re <b>Jane</b> Smith', caption_adds_info: false,
    case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_stage: 'Filed', case_status: 'Active',
    open: 'Jan. 4, 2026', file: 'Feb. 17, 2026', close: '',
    contacts: [{ contact_id: 2, contact_name: 'Jane Smith', contact_relate: 'Primary' }] },
];

async function boot({ userId = 6, stored, storageThrows = false } = {}) {
  const panel = slice('<label class="yc-f" data-nocount><span class="yc-f-l">Caption</span>', '<span class="yc-f yc-f-wide" data-nocount>');
  const table = slice('<table id="casesTable"', '<div id="casesTableFoot">');
  const jsd = new JSDOM(`<!DOCTYPE html><html><head><style>${CSS}</style></head><body>
    <div class="tab-main">
      <input id="tabCasesQuery"><div id="tabCasesLoad"></div>
      <select id="tabCasesType"><option value="%">All</option></select>
      <select id="tabCasesStage"><option value="%">All</option></select>
      <input id="tabCasesStatus">
      <select id="tabCasesOrder" data-type="sortBy"><option value="c.case_id">x</option></select>
      <select id="tabCasesOrder2" data-type="sortDi"><option value="ASC">A</option></select>
      ${panel}${table}<div id="casesTableFoot"></div>
    </div></body></html>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  if (stored) w.localStorage.setItem(`yc.cases.caption.${userId}`, stored);
  if (storageThrows) {
    Object.defineProperty(w, 'localStorage', { get() { throw new Error('denied'); } });
  }
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var user = ${JSON.stringify({ user: userId })};
    var offsets = {}, cases = null, limit = 100;
    var casesStale = false;
    var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var Toast = { fire() {} };
    var fmtCaseType = (c) => c.case_subtype;
    var fileLinkHtml = (label) => escText(label);
    window.fetches = 0;
    var apiSend = async () => { window.fetches++; return { total: ${CASES.length}, cases: ${JSON.stringify(CASES)} }; };
    function openMainTab() {}
    ${slice('const CASES_CAPTION_MODES', '/** Sole opener for the Cases tab')}
    ${fnSrc(INDEX, 'openCasesTab')}
    ${fnSrc(INDEX, 'tabCasesGet')}
    window.__open = openCasesTab;
  `);
  w.__open();
  await new Promise((r) => setTimeout(r, 10));
  return w;
}

const visible = (w, el) => w.getComputedStyle(el).display !== 'none';
const shownHeaders = (w) => [...w.document.querySelectorAll('#casesTable th')]
  .filter((th) => visible(w, th)).map((th) => th.textContent.trim());
const shownCells = (w, row) => [...w.document.querySelectorAll('#casesTable tr')[row].cells]
  .filter((td) => visible(w, td));

function choose(w, mode) {
  const sel = w.document.getElementById('tabCasesCaption');
  sel.value = mode;
  sel.dispatchEvent(new w.Event('change', { bubbles: true }));
}

const BEFORE = ['Lead ID', 'Client Name', 'Case Number', 'Case Type', 'Case Stage', 'Case Status',
  'Open Date', 'File Date', 'Close Date'];

test('the default is the column', async () => {
  const w = await boot();
  expect(w.document.getElementById('tabCasesCaption').value).toBe('column');
  expect(shownHeaders(w)).toContain('Caption');
  expect(shownCells(w, 1)[2].textContent).toBe('Schneyer v. Childs');
  expect(visible(w, w.document.querySelector('.caption-in-name'))).toBe(false);
});

test('Off is the table as it was: the same headers, the same cells', async () => {
  const w = await boot();
  choose(w, 'off');
  expect(shownHeaders(w)).toEqual(BEFORE);
  expect(shownCells(w, 1).map((td) => w.getComputedStyle(td).display).length).toBe(BEFORE.length);
  const client = shownCells(w, 1)[1];
  expect([...client.querySelectorAll('.caption-in-name')].filter((n) => visible(w, n))).toHaveLength(0);
});

test('In name drops the column and adds a line only where the caption says more', async () => {
  const w = await boot();
  choose(w, 'name');
  expect(shownHeaders(w)).toEqual(BEFORE);
  const lines = [...w.document.querySelectorAll('.caption-in-name')];
  expect(lines.map((n) => n.textContent)).toEqual(['Schneyer v. Childs']);
  expect(visible(w, lines[0])).toBe(true);
});

test('every mode scrolls in its own box instead of widening the page', async () => {
  const w = await boot();
  const table = w.document.getElementById('casesTable');
  for (const mode of ['column', 'name', 'off']) {
    choose(w, mode);
    expect(w.getComputedStyle(table).display).toBe('block');
    expect(w.getComputedStyle(table).overflowX).toBe('auto');
  }
});

test('a caption is text, never markup', async () => {
  const w = await boot();
  const cell = shownCells(w, 2)[2];
  expect(cell.textContent).toBe('In re <b>Jane</b> Smith');
  expect(cell.querySelector('b')).toBeNull();
});

test('the choice is saved for this user and comes back on the next open', async () => {
  const w = await boot({ userId: 6 });
  choose(w, 'off');
  expect(w.localStorage.getItem('yc.cases.caption.6')).toBe('off');
  w.document.getElementById('casesTable').dataset.caption = 'column';
  w.__open();
  expect(w.document.getElementById('casesTable').dataset.caption).toBe('off');
});

test('another user of the same browser keeps their own choice', async () => {
  const w = await boot({ userId: 7, stored: undefined });
  expect(w.document.getElementById('tabCasesCaption').value).toBe('column');
  expect(w.localStorage.getItem('yc.cases.caption.6')).toBeNull();
  const off = await boot({ userId: 7, stored: 'off' });
  expect(off.document.getElementById('tabCasesCaption').value).toBe('off');
});

test('a junk stored value reads as the default', async () => {
  const w = await boot({ stored: 'sideways' });
  expect(w.document.getElementById('casesTable').dataset.caption).toBe('column');
});

test('blocked storage still gives a working table', async () => {
  const w = await boot({ storageThrows: true });
  expect(shownHeaders(w)).toContain('Caption');
  choose(w, 'off');
  expect(shownHeaders(w)).toEqual(BEFORE);
});

test('changing it fetches nothing and counts as no filter', async () => {
  const w = await boot();
  const before = w.fetches;
  choose(w, 'off');
  await new Promise((r) => setTimeout(r, 5));
  expect(w.fetches).toBe(before);
  const bar = w.document.createElement('div');
  bar.className = 'yc-filters';
  bar.innerHTML = '<div class="yc-f-panel"></div>';
  bar.firstChild.appendChild(w.document.getElementById('tabCasesCaption').closest('.yc-f'));
  w.document.body.appendChild(bar);
  w.document.getElementById('tabCasesCaption').value = 'off';
  expect(w.ycFiltersActive(bar)).toBe(0);
});
