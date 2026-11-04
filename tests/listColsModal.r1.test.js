/**
 * tests/listColsModal.r1.test.js
 *
 * The shared Columns modal + order layer (custom_table_view R1, scripts.js):
 *   1. ycColsOrder — a stored CSV reorders a model copy; unknown keys drop;
 *      model keys the CSV lacks anchor-insert after their model predecessor;
 *      an empty/foreign CSV returns the model order; the input is never
 *      mutated;
 *   2. ycColsDialog — rows in given order; labels land as TEXT (a hostile cf
 *      label cannot execute) with sort glyphs stripped; checkboxes seed from
 *      visibleKeys; the ↑/↓ buttons move rows (edges are no-ops); dragover
 *      reorders; Reset order restores defaultKeys; Apply hands onSave the
 *      DOM order + checked keys; zero checked boxes is refused with a
 *      validation message and no save; Cancel saves nothing;
 *   3. the per-tab dialog openers hand the shared modal the ORDERED model,
 *      the tab's defaults and the live visible keys (cases lifted as the
 *      representative — the four fns are line-for-line twins).
 *
 *   npx jest tests/listColsModal.r1.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const INDEX = read('public/index.html');

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

/* A page with scripts.js and a FUNCTIONAL Swal stub: fire() renders the html
   into a popup div, runs didOpen, and parks preConfirm + the resolver on
   window so a test can drive the dialog like a user would. */
function page() {
  const jsd = new JSDOM('<!DOCTYPE html><body></body>', {
    url: 'https://app.4lsg.com/', runScripts: 'dangerously',
  });
  const w = jsd.window;
  w.eval(`
    window.Swal = {
      mixin: () => ({ fire: () => Promise.resolve({}) }),
      getPopup: () => window.__popup,
      showValidationMessage: (m) => { window.__validation = m; },
      fire: (opts) => {
        const popup = document.createElement('div');
        popup.innerHTML = opts.html || '';
        document.body.appendChild(popup);
        window.__popup = popup;
        window.__preConfirm = opts.preConfirm;
        if (opts.didOpen) opts.didOpen(popup);
        return new Promise((res) => { window.__resolve = res; });
      },
    };
    ${SCRIPTS}
  `);
  return w;
}

const MODEL = [
  { key: 'a', label: 'Alpha', default_on: true },
  { key: 'b', label: 'Date ⇅', default_on: true },
  { key: 'c', label: 'Caption', default_on: true },
  { key: 'cf_x', label: '<img src=x onerror="window.__pwn=1">', default_on: false },
];

const openDialog = (w, { visibleKeys = ['a', 'b', 'c'], cols = MODEL, defaultKeys } = {}) => {
  w.__onSave = [];
  w.__cols = cols;
  w.__visibleKeys = visibleKeys;
  w.__defaultKeys = defaultKeys || cols.map((c) => c.key);
  const done = w.eval(`ycColsDialog({
    title: 'T', cols: window.__cols, defaultKeys: window.__defaultKeys,
    visibleKeys: window.__visibleKeys, onSave: (v) => window.__onSave.push(v),
  })`);
  return { done, rows: () => [...w.__popup.querySelectorAll('.yc-cols-row')] };
};
const rowKeys = (rows) => rows().map((r) => r.dataset.key);
const confirm = async (w, done) => {
  const v = w.__preConfirm();
  w.__resolve(v === false ? { isConfirmed: false } : { isConfirmed: true, value: v });
  await done;
  return v;
};

describe('ycColsOrder', () => {
  const order = (w, csv) => w.eval(`ycColsOrder(window.__cols, ${JSON.stringify(csv)}).map((c) => c.key)`);
  let w;
  beforeAll(() => { w = page(); w.__cols = MODEL; });

  test('a stored CSV reorders; unknown keys drop; empty or foreign CSV = model order', () => {
    expect(order(w, 'c,a,b,cf_x')).toEqual(['c', 'a', 'b', 'cf_x']);
    expect(order(w, 'c,retired,a')).toEqual(['c', 'a', 'b', 'cf_x']);   // b, cf_x appended in model order
    expect(order(w, '')).toEqual(['a', 'b', 'c', 'cf_x']);
    expect(order(w, 'retired,gone')).toEqual(['a', 'b', 'c', 'cf_x']);
    expect(w.eval('window.__cols.map((c) => c.key)')).toEqual(['a', 'b', 'c', 'cf_x']);  // never mutated
  });

  test('model keys the CSV lacks append at the END, in model order', () => {
    // A column added after the order was saved (a later slice, or a cf
    // column loading after a pre-cf save) shows at the right edge until the
    // user places it — the saved part is never scrambled.
    expect(order(w, 'c,a,cf_x')).toEqual(['c', 'a', 'cf_x', 'b']);
    expect(order(w, 'c,b')).toEqual(['c', 'b', 'a', 'cf_x']);
  });
});

describe('ycColsDialog', () => {
  test('rows in given order; hostile label is TEXT; glyphs stripped; boxes seed from visibleKeys', () => {
    const w = page();
    const { rows } = openDialog(w, { visibleKeys: ['a', 'c'] });
    expect(rowKeys(rows)).toEqual(['a', 'b', 'c', 'cf_x']);
    const labels = rows().map((r) => r.querySelector('label span').textContent);
    expect(labels).toEqual(['Alpha', 'Date', 'Caption', '<img src=x onerror="window.__pwn=1">']);
    expect(w.__popup.querySelectorAll('img')).toHaveLength(0);
    expect(w.__pwn).toBeUndefined();
    expect(rows().map((r) => r.querySelector('input').checked)).toEqual([true, false, true, false]);
  });

  test('↑/↓ move a row one step; the edges are no-ops', () => {
    const w = page();
    const { rows } = openDialog(w);
    const btn = (key, dir) => rows().find((r) => r.dataset.key === key)
      .querySelectorAll('button')[dir === 'up' ? 0 : 1];
    btn('c', 'up').onclick();
    expect(rowKeys(rows)).toEqual(['a', 'c', 'b', 'cf_x']);
    btn('a', 'up').onclick();                               // already first
    expect(rowKeys(rows)).toEqual(['a', 'c', 'b', 'cf_x']);
    btn('cf_x', 'down').onclick();                          // already last
    expect(rowKeys(rows)).toEqual(['a', 'c', 'b', 'cf_x']);
    btn('a', 'down').onclick();
    expect(rowKeys(rows)).toEqual(['c', 'a', 'b', 'cf_x']);
  });

  test('dragover reorders (jsdom rects are 0 → drop lands after the hovered row)', () => {
    const w = page();
    const { rows } = openDialog(w);
    const list = w.__popup.querySelector('#ycColsList');
    const rowOf = (key) => rows().find((r) => r.dataset.key === key);
    rowOf('a').dispatchEvent(new w.Event('dragstart', { bubbles: true }));
    rowOf('c').dispatchEvent(new w.MouseEvent('dragover', { bubbles: true, cancelable: true }));
    list.dispatchEvent(new w.Event('dragend', { bubbles: true }));
    expect(rowKeys(rows)).toEqual(['b', 'c', 'a', 'cf_x']);
  });

  test('Reset order restores defaultKeys', () => {
    const w = page();
    const { rows } = openDialog(w);
    rows().find((r) => r.dataset.key === 'c').querySelectorAll('button')[0].onclick();  // c up
    expect(rowKeys(rows)).toEqual(['a', 'c', 'b', 'cf_x']);
    w.__popup.querySelector('#ycColsReset').onclick(new w.Event('click', { cancelable: true }));
    expect(rowKeys(rows)).toEqual(['a', 'b', 'c', 'cf_x']);
  });

  test('Apply hands onSave the DOM order and the checked keys', async () => {
    const w = page();
    const { done, rows } = openDialog(w, { visibleKeys: ['a', 'b', 'c'] });
    rows().find((r) => r.dataset.key === 'cf_x').querySelector('input').checked = true;
    rows().find((r) => r.dataset.key === 'b').querySelector('input').checked = false;
    rows().find((r) => r.dataset.key === 'c').querySelectorAll('button')[0].onclick();  // c up
    const v = await confirm(w, done);
    expect(v).toEqual({ orderedKeys: ['a', 'c', 'b', 'cf_x'], checkedKeys: ['a', 'c', 'cf_x'] });
    expect(w.__onSave).toEqual([v]);
  });

  test('zero checked boxes is refused — validation message, no save', async () => {
    const w = page();
    const { done, rows } = openDialog(w);
    rows().forEach((r) => { r.querySelector('input').checked = false; });
    const v = await confirm(w, done);
    expect(v).toBe(false);
    expect(w.__validation).toBe('Keep at least one column');
    expect(w.__onSave).toEqual([]);
  });

  test('Cancel saves nothing', async () => {
    const w = page();
    const { done } = openDialog(w);
    w.__resolve({ isConfirmed: false });
    await done;
    expect(w.__onSave).toEqual([]);
  });
});

describe('the per-tab opener (cases, the representative twin)', () => {
  test('casesColsDialog hands the shared modal the ORDERED model, defaults and live vis', () => {
    const w = page();
    w.eval(`
      var user = { user: 6 };
      ${constSrc(INDEX, 'CASES_COLUMNS')}
      var casesColsVis = CASES_COLUMNS.slice(0, 3);
      ${fnSrc(INDEX, 'casesColsKey')}
      ${fnSrc(INDEX, 'casesColsOrderKey')}
      ${fnSrc(INDEX, 'casesColsSave')}
      ${fnSrc(INDEX, 'casesColsDialog')}
      window.__dialogArgs = null;
      ycColsDialog = (a) => { window.__dialogArgs = a; };   // capture, don't open
      localStorage.setItem('yc.cases.cols_order.6', 'case_type,case_id');
      casesColsDialog();
      // const bindings are scoped to THIS eval — park what the asserts need
      window.__modelKeys = CASES_COLUMNS.map((c) => c.key);
      window.__visKeys = casesColsVis.map((c) => c.key);
    `);
    const a = w.__dialogArgs;
    expect(a.cols.map((c) => c.key).slice(0, 2)).toEqual(['case_type', 'case_id']);
    expect(a.cols).toHaveLength(w.__modelKeys.length);
    expect(a.defaultKeys).toEqual(w.__modelKeys);
    expect(a.visibleKeys).toEqual(w.__visKeys);
    expect(typeof a.onSave).toBe('function');
  });
});
