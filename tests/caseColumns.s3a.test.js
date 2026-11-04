/**
 * tests/caseColumns.s3a.test.js
 *
 * The Cases tab's column model + picker (custom_table_view S3a), the
 * Contacts S1+S2 gates replayed over CASES_COLUMNS:
 *   1. zero visible change — every cell byte-for-byte against the frozen
 *      pre-S3a fixture (tests/fixtures/caseColumns.s3a.json, captured from
 *      the old positional template), the generated header row equal to the
 *      static row S3a removed (col-caption class included), no sort mark at
 *      boot, nothing hostile executing;
 *   2. the driver's cls contract — `cls` lands on the column's <th> AND
 *      every <td> (the Caption column keeps the col-caption class the
 *      caption-mode CSS selects on), and a cls-less model renders exactly
 *      as before the field existed;
 *   3. the picker — ONE in-memory set (casesColsVis) renders headers and
 *      rows; a change saves the HIDDEN keys (yc.cases.cols_off.<uid>),
 *      re-renders with no refetch; marks survive hide/re-show of the sorted
 *      column; unknown stored keys drop; hide-all falls back to default_on;
 *      the last box can't be cleared; storage-throw still follows the
 *      click; a failed fetch nulls the cache (no stale redraw);
 *   4. the shipped block — headers build at parse time even when a YC.on
 *      registration throws; another window's save re-applies through the
 *      real storage listener; loadUserContext wires casesColsInit;
 *      data-nocount keeps the picker out of the filter counter.
 *
 *   npx jest tests/caseColumns.s3a.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const INDEX = read('public/index.html');
const FROZEN = JSON.parse(read('tests/fixtures/caseColumns.s3a.json'));

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
function constSrc(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  const open = m.index + m[0].length;
  const pairs = { '{': '}', '[': ']' };
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === src[open]) depth++;
    else if (src[j] === pairs[src[open]] && --depth === 0) return src.slice(m.index, j + 1) + ';';
  }
  throw new Error(`const ${name}: unbalanced`);
}

// The exact header row the static markup carried before S3a.
const OLD_HEADER = [
  `<th onclick="sort(this, 'c.case_id')">Lead ID</th>`,
  `<th onclick="sort(this, 'co.contact_lname')">Client Name</th>`,
  `<th class="col-caption" onclick="sort(this, 'c.case_caption')">Caption</th>`,
  `<th onclick="sort(this, 'c.case_number')">Case Number</th>`,
  `<th onclick="sort(this, 'c.case_type')">Case Type</th>`,
  `<th onclick="sort(this, 'c.case_stage')">Case Stage</th>`,
  `<th onclick="sort(this, 'c.case_status')">Case Status</th>`,
  `<th onclick="sort(this, 'c.case_open_date')">Open Date</th>`,
  `<th onclick="sort(this, 'c.case_file_date')">File Date</th>`,
  `<th onclick="sort(this, 'c.case_close_date')">Close Date</th>`,
];
const ALL_LABELS = ['Lead ID', 'Client Name', 'Caption', 'Case Number', 'Case Type',
  'Case Stage', 'Case Status', 'Open Date', 'File Date', 'Close Date'];
const ALL_KEYS = ['case_id', 'contacts', 'case_caption', 'case_number', 'case_type',
  'case_stage', 'case_status', 'open', 'file', 'close'];
const hideAllBut = (keep) => ALL_KEYS.filter((k) => k !== keep).join(',');
const drop = (labels, i) => labels.filter((_, n) => n !== i);

const PICKER_FNS = ['casesColsKey', 'casesColsOnKey', 'casesColsOrderKey', 'casesCfEnsure',
  'casesColsVisible', 'casesRenderRows', 'casesColsRender', 'casesColsApply',
  'casesColsDialog', 'casesColsSave', 'casesColsInit', 'tabCasesGet'];

function page({ userId = 6, storedOff, storageThrows = false, failFetch = false } = {}) {
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabCases" class="tab-main">
    <input id="tabCasesQuery"><div id="tabCasesLoad"></div>
    <input id="tabCasesStatus">
    <select id="tabCasesOrder" data-type="sortBy">
      <option value="co.contact_lname">Client</option><option value="c.case_close_date">Close</option>
    </select>
    <select id="tabCasesOrder2" data-type="sortDi">
      <option value="ASC">A</option><option value="DESC">D</option>
    </select>
    <button data-type="goButton"></button>
    <table id="casesTable" data-caption="column"><tr></tr></table><div id="casesTableFoot"></div>
  </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  if (storedOff != null) w.localStorage.setItem(`yc.cases.cols_off.${userId}`, storedOff);
  if (storageThrows) Object.defineProperty(w, 'localStorage', { get() { throw new Error('denied'); } });
  w.fetches = 0;
  w.__rows = FROZEN.rows;
  w.__fail = failFetch;
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var offsets = {}, cases = null;
    var user = ${JSON.stringify({ user: userId })};
    var YcPager = { getLimit: (k, d) => d, renderFooter(foot) { foot.textContent = 'pager'; } };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var Toast = { fire() {} };
    var casesTypeTreeBuild = () => {}, casesTypeValues = () => [],
        casesStageValues = () => [], casesTypeOtherChecked = () => false,
        casesTypeListed = () => [];
    var apiSend = async () => {
      window.fetches++;
      if (window.__fail) throw new Error('down');
      return { total: window.__rows.length, cases: JSON.parse(JSON.stringify(window.__rows)) };
    };
    ${constSrc(INDEX, 'CASES_COLUMNS')}
    var casesColsVis = CASES_COLUMNS, casesEverSorted = false, casesCfFetched = [];
    ${PICKER_FNS.map((f) => fnSrc(INDEX, f)).join('\n')}
    ycColsHeadRender(E('casesTable'), CASES_COLUMNS);   // the parse-time build
    casesColsInit();                                    // the loadUserContext build
    window.__go = tabCasesGet;
    window.__cols = CASES_COLUMNS;
    window.__vis = () => casesColsVis;
    window.__apply = casesColsApply;
    window.__save = casesColsSave;
  `);
  return w;
}

const cells = (w) => [...w.document.querySelectorAll('#casesTable tr')].slice(1)
  .map((tr) => [...tr.cells].map((td) => td.innerHTML));
const headTexts = (w) => [...w.document.querySelectorAll('#casesTable th')].map((th) => th.textContent.trim());
/* The modal's Apply, driven directly (R1): toggle one key against the
   CURRENT visible set and hand casesColsSave the whole model order — exactly
   what ycColsDialog's preConfirm produces for a plain checkbox change. The
   modal's own UI (checkboxes, drag, arrows, reset, zero-column refusal) is
   covered in tests/listColsModal.r1.test.js. */
const setBox = (w, key, on) => {
  const checked = new Set(w.__vis().map((c) => c.key));
  if (on) checked.add(key); else checked.delete(key);
  w.__save({ orderedKeys: w.__cols.map((c) => c.key), checkedKeys: [...checked] });
};
const visKeys = (w) => w.__vis().map((c) => c.key);
// Headers and rows must always agree — the S2-review invariant, kept here.
const expectAligned = (w) => {
  const ths = w.document.querySelectorAll('#casesTable th').length;
  for (const r of cells(w)) expect(r.length).toBe(ths);
};

describe('zero visible change — the model renders what the template rendered', () => {
  test('every cell and every td class, byte for byte, against the frozen fixture', async () => {
    const w = page();
    await w.__go(0);
    expect(cells(w)).toEqual(FROZEN.cells);
    const classes = [...w.document.querySelectorAll('#casesTable tr')].slice(1)
      .map((tr) => [...tr.cells].map((td) => td.getAttribute('class') || ''));
    expect(classes).toEqual(FROZEN.tdAttrs);
    expect(FROZEN.cells.length).toBe(4);               // the fixture itself
    expect(FROZEN.cells.every((r) => r.length === 10)).toBe(true);
    expect(FROZEN.tdAttrs.every((r) => r[2] === 'col-caption')).toBe(true);
    expectAligned(w);
  });

  test('the generated header row equals the static row S3a removed', () => {
    const w = page();
    const ths = [...w.document.querySelectorAll('#casesTable th')].map((th) => th.outerHTML);
    expect(ths).toEqual(OLD_HEADER);
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);   // no boot marks
  });

  test('nothing hostile executes or lands in the DOM', async () => {
    const w = page();
    await w.__go(0);
    const d = w.document;
    expect(w.__pwn).toBeUndefined();
    expect(d.getElementById('pwn')).toBeNull();
    expect(d.querySelectorAll('img')).toHaveLength(0);
    expect(d.querySelectorAll('[onmouseover]')).toHaveLength(0);
  });

  test('the model is well-formed: unique keys, labels, default_on, safe sort and cls shapes', () => {
    const w = page();
    const cols = w.__cols;
    expect(cols).toHaveLength(10);
    expect(cols.map((c) => c.key)).toEqual(ALL_KEYS);
    for (const c of cols) {
      expect(typeof c.label).toBe('string');
      expect(c.default_on).toBe(true);
      // sort, label and cls are interpolated into header/cell markup, so the
      // contract (scripts.js) demands static code literals; pin safe shapes.
      if (c.sort != null) expect(c.sort).toMatch(/^[a-z_.]+$/);
      if (c.cls != null) expect(c.cls).toMatch(/^[a-z-]+$/);
    }
    expect(cols.find((c) => c.key === 'case_caption').cls).toBe('col-caption');
  });
});

describe('choosing columns', () => {
  test('a change saves the HIDDEN keys, re-renders in memory, never refetches', async () => {
    const w = page();
    await w.__go(0);
    expect(w.fetches).toBe(1);
    setBox(w, 'case_stage', false);
    expect(w.fetches).toBe(1);                              // no refetch
    expect(w.localStorage.getItem('yc.cases.cols_off.6')).toBe('case_stage');
    expect(w.localStorage.getItem('yc.cases.cols_order.6')).toBe(ALL_KEYS.join(','));
    expect(headTexts(w)).toEqual(drop(ALL_LABELS, 5));
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 5)));
    expectAligned(w);
    setBox(w, 'case_stage', true);                          // and back
    expect(w.localStorage.getItem('yc.cases.cols_off.6')).toBe('');
    expect(cells(w)).toEqual(FROZEN.cells);
  });

  test('hiding the Caption column removes its th and tds; the rest keep col-caption pairing', async () => {
    const w = page();
    await w.__go(0);
    setBox(w, 'case_caption', false);
    expect(headTexts(w)).toEqual(drop(ALL_LABELS, 2));
    expect(w.document.querySelectorAll('#casesTable .col-caption')).toHaveLength(0);
    setBox(w, 'case_caption', true);
    // th + one td per fixture row carry the class again — the caption-mode
    // CSS (#casesTable[data-caption="off"] .col-caption) keeps its target.
    expect(w.document.querySelectorAll('#casesTable th.col-caption')).toHaveLength(1);
    expect(w.document.querySelectorAll('#casesTable td.col-caption')).toHaveLength(FROZEN.cells.length);
    expectAligned(w);
  });

  test('sort marks survive a picker change — hiding and re-showing the sorted column too', async () => {
    const w = page();
    await w.__go(0);
    w.document.getElementById('tabCasesOrder').value = 'c.case_close_date';
    w.document.getElementById('tabCasesOrder2').value = 'ASC';
    w.eval(`sortSelect(document.getElementById('tabCasesOrder'))`);
    expect(headTexts(w).at(-1)).toBe('Close Date ↑');
    await w.__go(0);                                        // a fetch never rebuilds headers
    expect(headTexts(w).at(-1)).toBe('Close Date ↑');
    setBox(w, 'case_stage', false);                         // unrelated column
    expect(headTexts(w).at(-1)).toBe('Close Date ↑');
    setBox(w, 'close', false);                              // hide the SORTED column
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);
    setBox(w, 'close', true);                               // its mark comes back
    expect(headTexts(w).at(-1)).toBe('Close Date ↑');
    expectAligned(w);
  });

  test('a sort chosen while its column is hidden still marks it on re-show', async () => {
    const w = page();
    await w.__go(0);
    setBox(w, 'close', false);                              // hide first
    const sel = w.document.getElementById('tabCasesOrder');
    sel.value = 'c.case_close_date';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));  // latch fires, no mark paintable
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);
    setBox(w, 'close', true);
    expect(headTexts(w).at(-1)).toBe('Close Date ↑');
  });

  test('a save that leaves nothing visible falls back to every default_on column', () => {
    // The dialog refuses zero checked boxes (listColsModal.r1), so this is
    // the belt-and-suspenders fallback behind it: checked keys the model
    // does not know cannot blank the screen.
    const w = page();
    w.__save({ orderedKeys: ALL_KEYS, checkedKeys: ['retired_column'] });
    expect(headTexts(w)).toEqual(ALL_LABELS);
  });

  test('the screen follows the click even when storage throws', async () => {
    const w = page({ storageThrows: true });
    await w.__go(0);
    setBox(w, 'case_stage', false);
    expect(headTexts(w)).toEqual(drop(ALL_LABELS, 5));
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 5)));
    expectAligned(w);
  });
});

describe('the stored choice', () => {
  test('hidden keys hide; unknown hidden keys drop; hiding everything falls back', () => {
    const w1 = page({ storedOff: 'case_stage,retired_column' });
    expect(headTexts(w1)).toEqual(drop(ALL_LABELS, 5));
    const w2 = page({ storedOff: 'retired_column' });
    expect(headTexts(w2)).toEqual(ALL_LABELS);
    const w3 = page({ storedOff: ALL_KEYS.join(',') });      // hand-edited to hide all
    expect(headTexts(w3)).toEqual(ALL_LABELS);               // default_on fallback
  });

  test('a column a later slice ADDS is visible without touching the pref', () => {
    const w = page({ storedOff: 'case_stage' });
    w.__cols.push({ key: 'cf_new', label: 'New', default_on: true, render: () => '' });
    w.__apply();
    expect(w.__vis().some((c) => c.key === 'cf_new')).toBe(true);
    expect(headTexts(w)).toContain('New');
  });

  test("the modal's Apply with a REORDERED answer repaints headers and cells in that order", async () => {
    const w = page();
    await w.__go(0);
    const rev = [...ALL_KEYS].reverse();
    w.__save({ orderedKeys: rev, checkedKeys: [...ALL_KEYS] });
    expect(headTexts(w)).toEqual([...ALL_LABELS].reverse());
    expect(cells(w)[0]).toEqual([...FROZEN.cells[0]].reverse());
    expect(w.localStorage.getItem('yc.cases.cols_order.6')).toBe(rev.join(','));
    expectAligned(w);
  });

  test("another window's cols_order save re-applies through the storage listener", async () => {
    const w = page();
    await w.__go(0);
    const rev = [...ALL_KEYS].reverse();
    w.localStorage.setItem('yc.cases.cols_order.6', rev.join(','));
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.cases.cols_order.6' }));
    expect(headTexts(w)).toEqual([...ALL_LABELS].reverse());
    expectAligned(w);
  });

  test('the key carries the user id', () => {
    const w = page({ userId: 22, storedOff: hideAllBut('case_id') });
    expect(headTexts(w)).toEqual(['Lead ID']);
    const other = page({ userId: 22 });
    other.localStorage.setItem('yc.cases.cols_off.6', hideAllBut('case_id'));  // another user's pref
    other.eval('casesColsApply()');
    expect(headTexts(other)).toEqual(ALL_LABELS);
  });

  test('a stored cols_order reorders headers AND cells together; later-added columns land in their natural spot', () => {
    const w = page({});
    w.localStorage.setItem('yc.cases.cols_order.6',
      ['case_type', 'case_id', 'contacts', 'case_caption', 'case_number',
        'case_stage', 'case_status', 'open', 'file', 'close'].join(','));
    w.eval('casesColsApply()');
    expect(headTexts(w)).toEqual(['Case Type', ...drop(ALL_LABELS, 4)]);
    // Unknown stored keys drop out; model columns the CSV lacks append at
    // the END in model order (ycColsOrder) — a later-added column shows at
    // the right edge until the user places it.
    w.localStorage.setItem('yc.cases.cols_order.6', 'close,retired_column,case_id');
    w.__cols.splice(1, 0, { key: 'inserted', label: 'Inserted', default_on: true, render: () => '' });
    w.eval('casesColsApply()');
    const h = headTexts(w);
    expect(h[0]).toBe('Close Date');
    expect(h[1]).toBe('Lead ID');
    expect(h[2]).toBe('Inserted');           // appended keys keep model order
    expect(h).toHaveLength(11);
  });
});

describe('failure paths stay aligned', () => {
  test('a failed fetch nulls the cache — a picker change cannot redraw the stale page', async () => {
    const w = page();
    await w.__go(0);                                        // one good page
    w.__fail = true;
    await w.__go(0);                                        // cleared rows, failed fetch
    expect(cells(w)).toEqual([]);
    const foot = w.document.getElementById('casesTableFoot').textContent;
    setBox(w, 'case_stage', false);
    expect(cells(w)).toEqual([]);                           // no stale redraw
    expect(w.document.getElementById('casesTableFoot').textContent).toBe(foot);
    expectAligned(w);
  });

  test('a picker change during an in-flight fetch cannot outlive its failure', async () => {
    // The race the review named: the fetch clears the rows, a picker click
    // redraws the PREVIOUS page from the cache while the fetch hangs, and
    // the fetch then fails. The catch must clear those rows, not leave them
    // under the error toast.
    const w = page();
    await w.__go(0);                                        // a page on screen
    let reject;
    w.__hang = new Promise((res, rej) => { reject = rej; });
    w.eval('apiSend = () => window.__hang');
    const pending = w.__go(0);                              // clears rows, hangs
    setBox(w, 'case_stage', false);                         // race: redraws the old page
    expect(cells(w)).toHaveLength(FROZEN.rows.length);      // stale rows ARE back
    reject(new Error('down'));
    await pending;                                          // catch runs
    expect(cells(w)).toEqual([]);                           // and cleared them
    expectAligned(w);
  });

  test('the Client Name render parses string-shaped contacts (the render-level guard)', () => {
    const w = page();
    const row = { ...FROZEN.rows[0], contacts: JSON.stringify(FROZEN.rows[0].contacts) };
    w.__row = row;
    const html = w.eval('ycColsRowHtml(window.__cols, window.__row)');
    const want = FROZEN.cells[0]
      .map((c, i) => `<td${FROZEN.tdAttrs[0][i] ? ` class="${FROZEN.tdAttrs[0][i]}"` : ''}>${c}</td>`).join('');
    expect(html).toBe(want);
  });

  test('an EMPTY fetch replaces the cache — a picker toggle cannot resurrect the page (S3b fix)', async () => {
    const w = page();
    await w.__go(0);
    w.__rows = [];
    await w.__go(0);                                        // the empty result
    expect(cells(w)).toEqual([]);
    setBox(w, 'case_stage', false);
    expect(cells(w)).toEqual([]);                           // no resurrection
    expectAligned(w);
  });

  test('a mid-flight picker change does not outlive an EMPTY response either (S3b fix)', async () => {
    const w = page();
    await w.__go(0);
    let resolve;
    w.__hang = new Promise((res) => { resolve = res; });
    w.eval('apiSend = () => window.__hang');
    const pending = w.__go(0);
    setBox(w, 'case_stage', false);                         // race: redraws the old page
    expect(cells(w)).toHaveLength(FROZEN.rows.length);
    resolve({ total: 0, cases: [] });
    await pending;
    expect(cells(w)).toEqual([]);                           // the empty branch cleared them
    expectAligned(w);
  });

  test('a reset cache ("" after logout) cannot leave rows under rebuilt headers (S3b fix)', async () => {
    const w = page();
    await w.__go(0);                                        // rows on screen
    w.eval('cases = ""');                                   // the logout reset shape
    setBox(w, 'case_stage', false);
    expect(cells(w)).toEqual([]);                           // cleared, not skipped
    expectAligned(w);
  });

  test('a picker change mid-page re-renders the page in memory and leaves the footer', async () => {
    const w = page();
    await w.__go(100);                                      // some offset
    const foot = w.document.getElementById('casesTableFoot').textContent;
    expect(foot).toBe('pager');
    setBox(w, 'contacts', false);
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 1)));
    expect(w.document.getElementById('casesTableFoot').textContent).toBe(foot);
    expectAligned(w);
  });
});

// Evaluate the WHOLE cases <script> block, as shipped, against the real
// table markup. This is the real gate for the top-level build call: a
// commented-out call, one wrapped in a function nobody runs, or one moved
// above the table (E() null) all fail it — a source-string pin would pass
// them all.
function evalCasesBlock(ycStub) {
  const declAt = INDEX.indexOf('const CASES_COLUMNS');
  const blockStart = INDEX.lastIndexOf('<script>', declAt) + '<script>'.length;
  const block = INDEX.slice(blockStart, INDEX.indexOf('</script>', declAt));
  const tableAt = INDEX.indexOf('<table id="casesTable"');
  const tableMarkup = INDEX.slice(tableAt, INDEX.indexOf('</table>', tableAt) + '</table>'.length);
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabCases" class="tab-main">${tableMarkup}
    <select id="tabCasesOrder" data-type="sortBy"><option value="co.contact_lname">C</option></select>
    <select id="tabCasesOrder2" data-type="sortDi"><option value="ASC">A</option></select>
    </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  let threw = null;
  try {
    w.eval(`
      window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
      window.YC = { on: ${ycStub} };    // the block registers sync-bus handlers
      ${SCRIPTS}
      var user = { user: 6 }, offsets = {}, cases = null;
      var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
      var exportListCsv = () => {}, csvFilterOf = (p) => p;
      var Toast = { fire() {} };
      var apiSend = async () => ({ total: 0, cases: [] });
      function openMainTab() {}
      function currentMainTabId() { return ''; }
      ${block}
    `);
  } catch (e) { threw = e; }
  const ths = [...w.document.querySelectorAll('#casesTable th')].map((th) => th.outerHTML);
  return { w, ths, threw };
}

describe('the shipped block', () => {
  test('builds the headers at parse time', () => {
    const { ths, threw } = evalCasesBlock('() => {}');
    expect(threw).toBeNull();
    expect(ths).toEqual(OLD_HEADER);
  });

  test('a sync-bus registration failure cannot leave the tab headerless', () => {
    // The build call sits ABOVE the block's YC.on registrations on purpose:
    // a yc-sync regression must not also strip the tab's headers. The block
    // still throws (liveness IS broken), but the headers are already there.
    const { ths, threw } = evalCasesBlock("() => { throw new Error('sync regression'); }");
    expect(threw).not.toBeNull();
    expect(ths).toEqual(OLD_HEADER);
  });

  test("another window's save re-applies here (the shipped storage listener)", () => {
    const { w, threw } = evalCasesBlock('() => {}');
    expect(threw).toBeNull();
    w.eval('casesColsInit()');
    expect([...w.document.querySelectorAll('#casesTable th')]).toHaveLength(10);
    w.cases = FROZEN.rows.slice(0, 1);                    // a page on screen
    w.eval('casesRenderRows()');
    w.localStorage.setItem('yc.cases.cols_off.6', 'case_stage');   // "another window" saved
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.cases.cols_off.6' }));
    expect([...w.document.querySelectorAll('#casesTable th')].map((t) => t.textContent.trim()))
      .toEqual(drop(ALL_LABELS, 5));
    // the rows follow in the same apply — never headers alone
    const row = w.document.querySelectorAll('#casesTable tr')[1];
    expect(row.cells).toHaveLength(9);
    expect(row.cells[5].innerHTML).toBe(FROZEN.cells[0][6]);  // status where stage was
  });
});

describe('the picker left the filter bar (R1)', () => {
  test('shipped markup: no Columns dropdown in the bar; the counter still counts a real filter', () => {
    const tabAt = INDEX.indexOf('<div id="tabCases"');
    const bar = INDEX.slice(INDEX.indexOf('<div class="yc-filters">', tabAt),
      INDEX.indexOf('<table id="casesTable"', tabAt));
    // The dropdown and its menu are gone — the modal (footer button) is the
    // only picker now.
    expect(bar).not.toContain('tabCasesColsMenu');
    expect(bar).not.toContain('id="tabCasesCols"');
    const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabCases">${bar}
      <table id="casesTable"><tr></tr></table></div></body>`,
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    const w = jsd.window;
    w.eval(`
      window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
      ${SCRIPTS}
      window.__active = (sel) => ycFiltersActive(document.querySelector(sel));
    `);
    expect(w.__active('.yc-filters')).toBe(0);
    const stage = w.document.querySelector('#tabCasesStage input');
    stage.checked = true;
    expect(w.__active('.yc-filters')).toBe(1);               // a real filter still counts
  });

  test('the footer carries the Columns entry point on success, empty and error outcomes', async () => {
    const w = page();
    w.eval(`
      window.__footOpts = [];
      YcPager.renderFooter = (foot, opts) => { window.__footOpts.push(opts); foot.textContent = 'pager'; };
    `);
    await w.__go(0);                                        // success
    w.__rows = [];
    await w.__go(0);                                        // empty
    w.__fail = true;
    await w.__go(0);                                        // error
    expect(w.__footOpts).toHaveLength(3);
    for (const o of w.__footOpts) expect(typeof o.onColumns).toBe('function');
  });
});

describe('boot wiring', () => {
  test('loadUserContext calls casesColsInit as a live statement', () => {
    const init = fnSrc(INDEX, 'loadUserContext');
    expect(init).toMatch(/^\s*casesColsInit\(\);$/m);        // not commented out
  });
});
