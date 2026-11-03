/**
 * tests/caseTypeMultiFilter.test.js
 *
 * The Cases-tab case-type multi filter (F3) — everything but the SQL, which
 * lives in tests/listSorting.mysql.test.js:
 *   1. casesTypeTreeBuild — the grouped tree from getCaseTypeMap(), idempotent
 *      and state-preserving;
 *   2. the subsume rule — a checked type force-checks and disables its
 *      subtype boxes, and restores them on uncheck;
 *   3. casesTypeValues — the tuple wire shape, disabled boxes excluded;
 *   4. tabCasesGet sends `types` as JSON only when something is checked (the
 *      default-state request stays byte-identical to pre-F3);
 *   5. GET /api/cases rejects a malformed `types` with a 400 that never
 *      reaches the DB, and hands a valid one to listCases parsed.
 * Real code throughout (scripts.js and the index.html functions run in
 * jsdom, the real route runs under express); only transport and DB stubbed.
 *
 *   npx jest tests/caseTypeMultiFilter.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { JSDOM } = require('jsdom');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());
jest.mock('../services/caseService', () => ({
  ...jest.requireActual('../services/caseService'),
  listCases: jest.fn(async () => ({ cases: [], total: 0 })),
}));
const caseService = require('../services/caseService');

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

// The live-ish registry shape: a type with subtypes, one without.
const MAP = {
  Bankruptcy: ['Chapter 7', 'Chapter 13'],
  'Civil, Litigation': ['100% Business'],
  Other: [],
};

const LIFTED = ['casesTypeTreeBuild', 'casesTypeChanged', 'casesTypeLabelSync', 'casesTypeValues',
  'casesTypeOtherChecked', 'casesTypeListed'];

function page() {
  const jsd = new JSDOM(`<!DOCTYPE html><html><body>
    <input id="tabCasesQuery"><div id="tabCasesLoad"></div>
    <details class="yc-multi" id="tabCasesType">
      <summary><span id="tabCasesTypeLabel">All</span></summary>
      <div class="yc-multi-menu" id="tabCasesTypeMenu"></div>
    </details>
    <input id="tabCasesStatus">
    <input id="tabCasesOrder" value="c.case_open_date"><input id="tabCasesOrder2" value="DESC">
    <table id="casesTable"><tr><th>h</th></tr></table><div id="casesTableFoot"></div>
    </body></html>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  w.calls = [];
  // Stub declarations come AFTER scripts.js, so they win where both declare.
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var offsets = {}, cases = null;
    var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var apiSend = async (url, method, params) => { window.calls.push({ url, method, params }); return { total: 0, cases: [] }; };
    function getCaseTypeMap() { return ${JSON.stringify(MAP)}; }
    function casesStageValues() { return []; }
    ${LIFTED.map((f) => fnSrc(INDEX, f)).join('\n')}
    ${fnSrc(INDEX, 'tabCasesGet')}
  `);
  w.casesTypeTreeBuild();
  return w;
}

const boxes = (w) => [...w.document.querySelectorAll('#tabCasesTypeMenu input')];
const box = (w, type, sub = '') => boxes(w).find((b) => !b.dataset.other && b.dataset.type === type && (b.dataset.subtype || '') === sub);
const otherBox = (w) => boxes(w).find((b) => b.dataset.other);
const click = (w, b) => { b.checked = !b.checked; b.dispatchEvent(new w.Event('change', { bubbles: true })); };
const label = (w) => w.document.getElementById('tabCasesTypeLabel').textContent;

describe('casesTypeTreeBuild — the grouped tree', () => {
  test('one row per type, its subtypes indented under it, Other (unlisted) last', () => {
    const w = page();
    const rows = boxes(w).map((b) => ({
      type: b.dataset.type, sub: b.dataset.subtype || '',
      indented: b.closest('label').classList.contains('yc-multi-sub'),
      other: !!b.dataset.other,
    }));
    expect(rows).toEqual([
      { type: 'Bankruptcy', sub: '', indented: false, other: false },
      { type: 'Bankruptcy', sub: 'Chapter 7', indented: true, other: false },
      { type: 'Bankruptcy', sub: 'Chapter 13', indented: true, other: false },
      { type: 'Civil, Litigation', sub: '', indented: false, other: false },
      { type: 'Civil, Litigation', sub: '100% Business', indented: true, other: false },
      { type: 'Other', sub: '', indented: false, other: false },
      { type: undefined, sub: '', indented: false, other: true },
    ]);
    expect(boxes(w).at(-1).closest('label').textContent.trim()).toBe('Other (unlisted)');
    // the complement basis is the whole-type rows, in order
    expect(w.casesTypeListed()).toEqual(['Bankruptcy', 'Civil, Litigation', 'Other']);
    expect(label(w)).toBe('All');
  });

  test('a rebuild preserves checked, subsumed and prior state', () => {
    const w = page();
    click(w, box(w, 'Civil, Litigation', '100% Business'));
    click(w, box(w, 'Bankruptcy', 'Chapter 7'));
    click(w, box(w, 'Bankruptcy'));            // subsumes Chapter 7's check
    w.casesTypeTreeBuild();
    expect(w.casesTypeValues()).toEqual([['Bankruptcy'], ['Civil, Litigation', '100% Business']]);
    const ch7 = box(w, 'Bankruptcy', 'Chapter 7');
    expect(ch7.disabled).toBe(true);
    click(w, box(w, 'Bankruptcy'));            // uncheck survives the rebuild:
    expect(w.casesTypeValues()).toEqual([      // Chapter 7's prior check returns
      ['Bankruptcy', 'Chapter 7'], ['Civil, Litigation', '100% Business']]);
  });
});

describe('the subsume rule and the wire shape', () => {
  test('a checked type force-checks and disables its subtypes; uncheck restores', () => {
    const w = page();
    click(w, box(w, 'Bankruptcy', 'Chapter 13'));
    expect(w.casesTypeValues()).toEqual([['Bankruptcy', 'Chapter 13']]);

    click(w, box(w, 'Bankruptcy'));
    for (const sub of ['Chapter 7', 'Chapter 13']) {
      const b = box(w, 'Bankruptcy', sub);
      expect(b.checked).toBe(true);
      expect(b.disabled).toBe(true);
      expect(b.closest('label').classList.contains('yc-multi-dim')).toBe(true);
    }
    // another type's subtree is untouched
    expect(box(w, 'Civil, Litigation', '100% Business').disabled).toBe(false);
    // the whole type rides alone — no pair tuples under it
    expect(w.casesTypeValues()).toEqual([['Bankruptcy']]);

    click(w, box(w, 'Bankruptcy'));
    expect(box(w, 'Bankruptcy', 'Chapter 13').checked).toBe(true);   // restored
    expect(box(w, 'Bankruptcy', 'Chapter 7').checked).toBe(false);   // restored
    expect(box(w, 'Bankruptcy', 'Chapter 7').disabled).toBe(false);
    expect(w.casesTypeValues()).toEqual([['Bankruptcy', 'Chapter 13']]);
  });

  test('the summary label: All, up to two names, then a count', () => {
    const w = page();
    expect(label(w)).toBe('All');
    click(w, box(w, 'Other'));
    expect(label(w)).toBe('Other');
    click(w, box(w, 'Bankruptcy', 'Chapter 7'));
    expect(label(w)).toBe('Bankruptcy: Chapter 7, Other');
    click(w, box(w, 'Civil, Litigation'));
    expect(label(w)).toBe('3 selected');
  });
});

describe('the Other (unlisted) row', () => {
  test('is not a tuple, counts in the label, and is distinct from a type named Other', () => {
    const w = page();
    click(w, otherBox(w));
    expect(w.casesTypeValues()).toEqual([]);          // no tuple from it
    expect(w.casesTypeOtherChecked()).toBe(true);
    expect(label(w)).toBe('Other');
    // a registry type literally named 'Other' is a different checkbox
    click(w, box(w, 'Other'));
    expect(w.casesTypeValues()).toEqual([['Other']]);
    expect(label(w)).toBe('Other, Other');
  });

  test('is independent of the subsume rule and survives a rebuild', () => {
    const w = page();
    click(w, otherBox(w));
    click(w, box(w, 'Bankruptcy'));
    // the type's subsume touched its own subtree only
    expect(otherBox(w).checked).toBe(true);
    expect(otherBox(w).disabled).toBe(false);
    w.casesTypeTreeBuild();
    expect(w.casesTypeOtherChecked()).toBe(true);
    expect(w.casesTypeValues()).toEqual([['Bankruptcy']]);
  });
});

describe('tabCasesGet sends what the route reads', () => {
  test('nothing checked sends no types key at all', async () => {
    const w = page();
    await w.tabCasesGet(0, true);
    expect(w.calls[0].params).not.toHaveProperty('types');
  });

  test('checked boxes ride as one JSON array of tuples', async () => {
    const w = page();
    click(w, box(w, 'Bankruptcy'));
    click(w, box(w, 'Civil, Litigation', '100% Business'));
    await w.tabCasesGet(0, true);
    expect(JSON.parse(w.calls[0].params.types))
      .toEqual([['Bankruptcy'], ['Civil, Litigation', '100% Business']]);
    expect(w.calls[0].params).not.toHaveProperty('types_not');
  });

  test('Other checked rides as types_not = the displayed whole-type list', async () => {
    const w = page();
    click(w, otherBox(w));
    click(w, box(w, 'Bankruptcy'));
    await w.tabCasesGet(0, true);
    expect(JSON.parse(w.calls[0].params.types)).toEqual([['Bankruptcy']]);
    expect(JSON.parse(w.calls[0].params.types_not))
      .toEqual(['Bankruptcy', 'Civil, Litigation', 'Other']);
  });
});

describe('GET /api/cases?types=', () => {
  let server; let base;
  beforeAll(async () => {
    const app = express();
    app.use((req, res, next) => { req.db = {}; next(); });
    app.use(require('../routes/api.cases'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => caseService.listCases.mockClear());

  const get = (qs) => fetch(`${base}/api/cases${qs}`);

  test('a valid tuple array reaches listCases parsed', async () => {
    const types = [['Bankruptcy'], ['Civil, Litigation', '100% Business']];
    const r = await get(`?types=${encodeURIComponent(JSON.stringify(types))}`);
    expect(r.status).toBe(200);
    expect(caseService.listCases.mock.calls[0][1].types).toEqual(types);
  });

  test('absent or empty sends null — the legacy path untouched', async () => {
    expect((await get('')).status).toBe(200);
    expect(caseService.listCases.mock.calls[0][1].types).toBeNull();
    expect((await get('?types=')).status).toBe(200);
    expect(caseService.listCases.mock.calls[1][1].types).toBeNull();
    expect((await get(`?types=${encodeURIComponent('[]')}`)).status).toBe(200);
    expect(caseService.listCases.mock.calls[2][1].types).toBeNull();
  });

  test.each([
    ['not JSON', 'Bankruptcy'],
    ['not an array', '{"type":"Bankruptcy"}'],
    ['a bare string entry', '["Bankruptcy"]'],
    ['an empty tuple', '[[]]'],
    ['an empty type', '[[""]]'],
    ['an empty subtype', '[["Bankruptcy",""]]'],
    ['a three-part tuple', '[["a","b","c"]]'],
    ['a non-string member', '[[1]]'],
  ])('%s is a 400 that never reaches the service', async (_, raw) => {
    const r = await get(`?types=${encodeURIComponent(raw)}`);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/tuples/);
    expect(caseService.listCases).not.toHaveBeenCalled();
  });

  test('an oversize array is a 400, not a giant WHERE', async () => {
    const big = JSON.stringify(Array.from({ length: 101 }, (_, i) => [`t${i}`]));
    expect((await get(`?types=${encodeURIComponent(big)}`)).status).toBe(400);
    expect(caseService.listCases).not.toHaveBeenCalled();
  });
});

describe('GET /api/cases?types_not=', () => {
  let server; let base;
  beforeAll(async () => {
    const app = express();
    app.use((req, res, next) => { req.db = {}; next(); });
    app.use(require('../routes/api.cases'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));
  beforeEach(() => caseService.listCases.mockClear());

  const get = (qs) => fetch(`${base}/api/cases${qs}`);

  test('a valid list reaches listCases parsed; [] stays meaningful', async () => {
    const listed = ['Bankruptcy', 'Civil, Litigation'];
    expect((await get(`?types_not=${encodeURIComponent(JSON.stringify(listed))}`)).status).toBe(200);
    expect(caseService.listCases.mock.calls[0][1].typesNot).toEqual(listed);
    expect((await get(`?types_not=${encodeURIComponent('[]')}`)).status).toBe(200);
    expect(caseService.listCases.mock.calls[1][1].typesNot).toEqual([]);
    expect((await get('')).status).toBe(200);
    expect(caseService.listCases.mock.calls[2][1].typesNot).toBeNull();
  });

  test.each([
    ['not JSON', 'Bankruptcy'],
    ['not an array', '{"a":1}'],
    ['a non-string member', '[1]'],
    ['an empty string member', '[""]'],
    ['a tuple member', '[["Bankruptcy"]]'],
  ])('%s is a 400 that never reaches the service', async (_, raw) => {
    const r = await get(`?types_not=${encodeURIComponent(raw)}`);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/types_not/);
    expect(caseService.listCases).not.toHaveBeenCalled();
  });

  test('an oversize list is a 400', async () => {
    const big = JSON.stringify(Array.from({ length: 101 }, (_, i) => `t${i}`));
    expect((await get(`?types_not=${encodeURIComponent(big)}`)).status).toBe(400);
    expect(caseService.listCases).not.toHaveBeenCalled();
  });
});
