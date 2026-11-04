/**
 * tests/caseColumns.s4.test.js
 *
 * Custom-field columns in the Cases tab (custom_table_view S4 client):
 *   1. the storage extension — default_on columns keep the HIDDEN-keys
 *      semantics (cols_off), default_on:false columns (the cf columns) are
 *      governed by the TURNED-ON set (cols_on): hidden for everyone until
 *      turned on, per browser and per user; old off-only stored values keep
 *      working; the storage listener reacts to both keys;
 *   2. the registry append — flagged ACTIVE case defs become picker entries
 *      (inactive/unflagged/hostile-key defs never do; a hostile label is
 *      escaped); the Order By select gains scalar cf options; init failure
 *      or a second init cannot hurt the tab;
 *   3. rendering per type (design memo D4) through ycCfCellText — select
 *      shows the stored VALUE, date the lists' house format, boolean
 *      Yes/blank, multiselect comma-joined;
 *   4. reveal-refetch — turning ON a cf column whose data the cached rows
 *      lack triggers ONE silent refetch carrying params.cf (the flagged
 *      exception to "a picker change never fetches"); hiding, re-showing
 *      fetched data, and non-cf toggles never fetch; another window's
 *      storage event takes the same path;
 *   5. the view export includes visible cf columns, file text = cell text.
 *
 *   npx jest tests/caseColumns.s4.test.js
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
/** A one-line const (regex literal etc.) by source slice. */
function constLine(src, name) {
  const at = src.indexOf(`const ${name}`);
  if (at < 0) throw new Error(`const ${name} not found`);
  return src.slice(at, src.indexOf(';', at) + 1);
}

const DEFS = [
  { id: 1, entity: 'case', field_key: 'cf_court', label: 'Court', field_type: 'select',
    options: [{ value: 'MIEB', label: 'Michigan Eastern' }], list_column: 1, active: 1 },
  { id: 2, entity: 'case', field_key: 'cf_filed', label: 'CF Filed', field_type: 'date', list_column: 1, active: 1 },
  { id: 3, entity: 'case', field_key: 'cf_rush', label: 'Rush?', field_type: 'boolean', list_column: 1, active: 1 },
  { id: 4, entity: 'case', field_key: 'cf_tags', label: 'Tags', field_type: 'multiselect', list_column: 1, active: 1 },
  { id: 5, entity: 'case', field_key: 'cf_retired', label: 'Retired', field_type: 'text', list_column: 1, active: 0 },
  { id: 6, entity: 'case', field_key: 'cf_unflagged', label: 'Unflagged', field_type: 'text', list_column: 0, active: 1 },
  { id: 7, entity: 'case', field_key: 'cf_bad`key', label: 'Hostile Key', field_type: 'text', list_column: 1, active: 1 },
  { id: 8, entity: 'case', field_key: 'cf_hostile', label: '<img src=x onerror="window.__pwn=1">', field_type: 'text', list_column: 1, active: 1 },
];
const CF_VALUES = {
  101: { cf_court: 'MIEB', cf_filed: '2026-11-20', cf_rush: 'true', cf_tags: '["a","z"]', cf_hostile: 'v' },
  102: { cf_court: null, cf_filed: null, cf_rush: null, cf_tags: null, cf_hostile: null },
};
const ROWS = [
  { case_id: 101, case_number: '24-1', case_caption: '', case_type: 'BK', case_stage: 'Open',
    case_status: 'Active', open: '', file: '', close: '', caption_adds_info: 0, contacts: [] },
  { case_id: 102, case_number: '24-2', case_caption: '', case_type: 'BK', case_stage: 'Open',
    case_status: 'Active', open: '', file: '', close: '', caption_adds_info: 0, contacts: [] },
];

const PICKER_FNS = ['casesColsKey', 'casesColsOnKey', 'casesColsOrderKey', 'casesCfEnsure',
  'casesColsVisible', 'casesRenderRows', 'casesColsRender', 'casesColsApply',
  'casesColsDialog', 'casesColsSave',
  'casesColsInit', 'casesCfColumns', 'casesCfInit', 'casesViewColumns', 'tabCasesGet'];

function page({ userId = 6, storedOff, storedOn, defs = DEFS } = {}) {
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabCases" class="tab-main">
    <input id="tabCasesQuery"><div id="tabCasesLoad"></div>
    <input id="tabCasesStatus">
    <select id="tabCasesOrder" data-type="sortBy">
      <option value="co.contact_lname" selected>Client</option>
    </select>
    <select id="tabCasesOrder2" data-type="sortDi"><option value="ASC" selected>A</option></select>
    <button data-type="goButton"></button>
    <table id="casesTable" data-caption="column"><tr></tr></table><div id="casesTableFoot"></div>
  </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  if (storedOff != null) w.localStorage.setItem(`yc.cases.cols_off.${userId}`, storedOff);
  if (storedOn != null) w.localStorage.setItem(`yc.cases.cols_on.${userId}`, storedOn);
  w.__defs = defs;
  w.__rows = ROWS;
  w.__cfValues = CF_VALUES;
  w.listFetches = 0;
  w.lastListParams = null;
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
    // The honest server mimic: defs from the registry; list rows carry
    // exactly the cf keys params.cf asked for, from the per-case value map.
    var apiSend = async (url, method, params) => {
      if (url === '/api/field-defs') {
        if (window.__defsFail) throw new Error('defs down');
        return { defs: window.__defs };
      }
      window.listFetches++;
      // Bounded fuse (C2 hardening, both tabs' suites): a mutant that breaks
      // the ensure/fetched handshake loops ensure→fetch→ensure as pure
      // microtasks and WEDGES the run instead of failing it. The throw lands
      // in tabCasesGet's catch, which nulls the cache; ensure's !cases guard
      // stops the loop, and the fetch-count assertions fail loudly.
      if (window.listFetches > 25) throw new Error('refetch runaway');
      window.lastListParams = params;
      const cfKeys = params && params.cf ? JSON.parse(params.cf) : [];
      const rows = window.__rows.map((r) => {
        const out = JSON.parse(JSON.stringify(r));
        for (const k of cfKeys) out[k] = (window.__cfValues[r.case_id] || {})[k] ?? null;
        return out;
      });
      return { total: rows.length, cases: rows };
    };
    ${constSrc(INDEX, 'CASES_COLUMNS')}
    ${constLine(INDEX, 'CASES_CF_KEY_RE')}
    var casesColsVis = CASES_COLUMNS, casesEverSorted = false, casesCfFetched = [];
    ${PICKER_FNS.map((f) => fnSrc(INDEX, f)).join('\n')}
    ycColsHeadRender(E('casesTable'), CASES_COLUMNS);   // the parse-time build
    casesColsInit();                                    // the loadUserContext builds
    window.__cfInit = casesCfInit;
    window.__go = tabCasesGet;
    window.__cols = CASES_COLUMNS;
    window.__vis = () => casesColsVis;
    window.__view = casesViewColumns;
    window.__save = casesColsSave;
  `);
  return w;
}
const cfReady = async (w) => { await w.__cfInit(); };

const cells = (w) => [...w.document.querySelectorAll('#casesTable tr')].slice(1)
  .map((tr) => [...tr.cells].map((td) => td.innerHTML));
const headTexts = (w) => [...w.document.querySelectorAll('#casesTable th')].map((th) => th.textContent.trim());
/* The modal's Apply, driven directly (R1) — see caseColumns.s3a. */
const setBox = (w, key, on) => {
  const checked = new Set(w.__vis().map((c) => c.key));
  if (on) checked.add(key); else checked.delete(key);
  w.__save({ orderedKeys: w.__cols.map((c) => c.key), checkedKeys: [...checked] });
};
const settle = (w) => new Promise((r) => w.setTimeout(r, 0));
const STATIC_N = 10;

describe('the registry append', () => {
  test('flagged active defs join the model (the modal lists it), hidden by default; the rest never do', async () => {
    const w = page();
    await cfReady(w);
    const keys = w.__cols.map((c) => c.key);
    expect(keys).toHaveLength(STATIC_N + 5);            // court, filed, rush, tags, hostile-label
    for (const k of ['cf_court', 'cf_filed', 'cf_rush', 'cf_tags', 'cf_hostile']) expect(keys).toContain(k);
    for (const k of ['cf_retired', 'cf_unflagged', 'cf_bad`key']) expect(keys).not.toContain(k);
    expect(headTexts(w)).toHaveLength(STATIC_N);        // all cf hidden by default
    expect(w.__pwn).toBeUndefined();                    // hostile label never executed
    expect(w.document.querySelectorAll('img')).toHaveLength(0);
  });

  test('the Order By select gains scalar cf options only, labeled from the def', async () => {
    const w = page();
    await cfReady(w);
    const opts = [...w.document.getElementById('tabCasesOrder').options].map((o) => [o.value, o.textContent]);
    expect(opts).toContainEqual(['cf_court', 'Court']);
    expect(opts).toContainEqual(['cf_filed', 'CF Filed']);
    expect(opts.map(([v]) => v)).not.toContain('cf_tags');   // multiselect never sorts
  });

  test('a defs failure or an empty registry costs only the cf columns', async () => {
    const w = page();
    w.__defsFail = true;
    await cfReady(w);
    expect(headTexts(w)).toHaveLength(STATIC_N);
    await w.__go(0);
    expect(cells(w)).toHaveLength(2);                   // the tab still works
    const w2 = page({ defs: [] });
    await cfReady(w2);
    expect(w2.__cols).toHaveLength(STATIC_N);
  });

  test('a second init is a no-op — no duplicate columns', async () => {
    const w = page();
    await cfReady(w);
    await cfReady(w);
    expect(w.__cols.filter((c) => c.key === 'cf_court')).toHaveLength(1);
  });

  test('a hostile label lands as text in the generated header', async () => {
    const w = page({ storedOn: 'cf_hostile' });
    await cfReady(w);
    expect(headTexts(w)).toContain('<img src=x onerror="window.__pwn=1">');
    expect(w.document.querySelectorAll('#casesTable img')).toHaveLength(0);
    expect(w.__pwn).toBeUndefined();
  });
});

describe('the storage extension', () => {
  test('turning a cf column on writes cols_on; default columns keep cols_off; both restore', async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    setBox(w, 'cf_court', true);
    await settle(w);
    expect(w.localStorage.getItem('yc.cases.cols_on.6')).toBe('cf_court');
    expect(w.localStorage.getItem('yc.cases.cols_off.6')).toBe('');
    setBox(w, 'case_stage', false);
    expect(w.localStorage.getItem('yc.cases.cols_off.6')).toBe('case_stage');
    expect(w.localStorage.getItem('yc.cases.cols_on.6')).toBe('cf_court');
    const again = page({ storedOff: 'case_stage', storedOn: 'cf_court' });
    await cfReady(again);
    expect(headTexts(again)).toContain('Court');
    expect(headTexts(again)).not.toContain('Case Stage');
  });

  test('an old off-only stored value keeps working; unknown cols_on keys drop', async () => {
    const w = page({ storedOff: 'case_stage' });          // pre-S4 shape, no cols_on
    await cfReady(w);
    expect(headTexts(w)).toHaveLength(STATIC_N - 1);
    expect(headTexts(w)).not.toContain('Case Stage');
    const w2 = page({ storedOn: 'cf_gone,cf_court' });    // a retired cf key lingers
    await cfReady(w2);
    expect(headTexts(w2)).toContain('Court');
    expect(headTexts(w2)).toHaveLength(STATIC_N + 1);
  });

  test("another window's cols_on save re-applies here and fetches the data", async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    const before = w.listFetches;
    w.localStorage.setItem('yc.cases.cols_on.6', 'cf_court');
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.cases.cols_on.6' }));
    await settle(w);
    expect(headTexts(w)).toContain('Court');
    expect(w.listFetches).toBe(before + 1);              // the reveal-refetch
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_court']);
  });
});

describe('rendering per type (D4)', () => {
  test('select VALUE, house date, boolean Yes/blank, multiselect joined, null blank', async () => {
    const w = page({ storedOn: 'cf_court,cf_filed,cf_rush,cf_tags' });
    await cfReady(w);
    await w.__go(0);
    const h = headTexts(w);
    const row1 = cells(w)[0]; const row2 = cells(w)[1];
    const at = (lbl) => h.indexOf(lbl);
    expect(row1[at('Court')]).toBe('MIEB');              // the stored VALUE, not the label
    expect(row1[at('CF Filed')]).toBe('Nov. 20, 2026');  // the lists' house format
    expect(row1[at('Rush?')]).toBe('Yes');
    expect(row1[at('Tags')]).toBe('a, z');
    expect(row2[at('Court')]).toBe('');
    expect(row2[at('Rush?')]).toBe('');
  });

  test('the view export carries the visible cf columns, file text = cell text', async () => {
    const w = page({ storedOn: 'cf_court,cf_filed' });
    await cfReady(w);
    await w.__go(0);
    const view = w.__view();
    const court = view.find((c) => c.key === 'cf_court');
    const filed = view.find((c) => c.key === 'cf_filed');
    expect(court).toBeDefined();
    expect(court.csv(ROWS_CF(101))).toBe('MIEB');
    expect(filed.csv(ROWS_CF(101))).toBe('Nov. 20, 2026');
    function ROWS_CF(id) { return { ...ROWS.find((r) => r.case_id === id), ...CF_VALUES[id] }; }
  });
});

describe('the reveal-refetch', () => {
  test('revealing an unfetched cf column fetches ONCE with params.cf; everything else never fetches', async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    expect(w.listFetches).toBe(1);
    expect(w.lastListParams.cf).toBeUndefined();         // default request byte-identical
    setBox(w, 'cf_court', true);
    await settle(w);
    expect(w.listFetches).toBe(2);                       // the one silent refetch
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_court']);
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Court')]).toBe('MIEB');
    setBox(w, 'cf_court', false);                        // hide: render only
    await settle(w);
    expect(w.listFetches).toBe(2);
    setBox(w, 'cf_court', true);                         // re-show: data already on hand
    await settle(w);
    expect(w.listFetches).toBe(2);
    expect(cells(w)[0][headTexts(w).indexOf('Court')]).toBe('MIEB');
    setBox(w, 'case_stage', false);                      // a static toggle never fetches
    await settle(w);
    expect(w.listFetches).toBe(2);
  });

  test('the boot race: defs landing while the first fetch is in flight cannot leave Court blank', async () => {
    // F5 straight into Cases: tabCasesGet(0) is dispatched from the static
    // model (no cf), the tiny defs call answers first and grows the visible
    // set, then the list lands and renders blank Court cells from rows that
    // never carried the data (review-caught). The end-of-fetch ensure must
    // issue exactly one follow-up that fills them.
    const w = page({ storedOn: 'cf_court' });
    let releaseList;
    w.__hold = new Promise((res) => { releaseList = res; });
    w.eval(`
      const realApi = apiSend;
      let held = false;
      apiSend = async (url, method, params) => {
        if (url !== '/api/field-defs' && !held) {
          held = true;
          const r = realApi(url, method, params);   // counted now, delivered later
          await window.__hold;
          return r;
        }
        return realApi(url, method, params);
      };
    `);
    const boot = w.__go(0);                              // the pre-init fetch, no cf
    await cfReady(w);                                    // defs win the race
    expect(headTexts(w)).toContain('Court');             // the grown header is up
    releaseList();
    await boot;
    await settle(w);
    await settle(w);                                     // the follow-up fetch settles
    expect(w.listFetches).toBe(2);                       // exactly one ensure refetch
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Court')]).toBe('MIEB');  // never left blank
  });

  test('Order By a HIDDEN cf column still rides the key — the sort reaches the server', async () => {
    const w = page();
    await cfReady(w);
    const sel = w.document.getElementById('tabCasesOrder');
    sel.value = 'cf_court';                              // Court column stays hidden
    await w.__go(0);
    expect(w.lastListParams.sort_by).toBe('cf_court');
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_court']);  // selected, so honored
    sel.value = 'co.contact_lname';                      // a static sort adds nothing
    await w.__go(0);
    expect(w.lastListParams.cf).toBeUndefined();
  });

  test('a picker change before the defs arrive cannot erase the stored Court choice', async () => {
    const w = page({ storedOn: 'cf_court' });
    w.__defsFail = true;
    await cfReady(w);                                    // static model only
    setBox(w, 'case_stage', false);                      // unrelated toggle
    expect(w.localStorage.getItem('yc.cases.cols_on.6')).toBe('cf_court');  // kept
  });

  test('before any fetch, turning a cf column on fetches nothing (first open will)', async () => {
    const w = page();
    await cfReady(w);
    setBox(w, 'cf_court', true);
    await settle(w);
    expect(w.listFetches).toBe(0);
    await w.__go(0);                                     // the first open carries it
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_court']);
  });
});

describe('ycCfCellText edge shapes (the live column types)', () => {
  test('multiselect arrives as a real ARRAY from the JSON column; number trims DECIMAL zeros', () => {
    const w = page();
    w.__v = ['a', 'z'];
    expect(w.eval(`ycCfCellText('multiselect', window.__v)`)).toBe('a, z');   // mysql2's real shape
    expect(w.eval(`ycCfCellText('multiselect', '["a","z"]')`)).toBe('a, z'); // the string shape too
    expect(w.eval(`ycCfCellText('number', '1234.5000')`)).toBe('1234.5');
    expect(w.eval(`ycCfCellText('number', '1234.0000')`)).toBe('1234');
    expect(w.eval(`ycCfCellText('number', '7')`)).toBe('7');
    expect(w.eval(`ycCfCellText('number', '-2.5000')`)).toBe('-2.5');
  });
});

describe('hostile cf VALUES land as text', () => {
  test('a stored value carrying markup is escaped by the cf render', async () => {
    const w = page({ storedOn: 'cf_court' });
    w.__cfValues = { ...CF_VALUES, 101: { ...CF_VALUES[101], cf_court: '<img src=x onerror="window.__pwn=3">' } };
    await cfReady(w);
    await w.__go(0);
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Court')]).toContain('&lt;img');
    expect(w.document.querySelectorAll('#casesTable img')).toHaveLength(0);
    expect(w.__pwn).toBeUndefined();
  });
});

// The Fields editor's wire contract — source pins, the customFields.s6
// precedent (the page's behavior is delegation-heavy; the contract is what
// the writes carry and what the load adopts).
describe('the Fields editor carries list_column (S4)', () => {
  const CFG = read('public/caseconfig/fields.html');

  test('both writes send it, always, as 0/1', () => {
    expect(CFG.match(/list_column: t\.list_column \? 1 : 0,/g) || []).toHaveLength(2);
  });

  test('the load adopts it; the checkbox is wired and marks dirty', () => {
    expect(CFG).toMatch(/list_column: d\.list_column \? 1 : 0,/);
    expect(CFG).toMatch(/data-cf-listcol="\$\{i\}" \$\{t\.list_column \? 'checked' : ''\}/);
    expect(CFG).toMatch(/d\.cfListcol !== undefined[\s\S]{0,120}list_column = el\.checked \? 1 : 0;[\s\S]{0,80}cfMarkDirty\(d\.cfListcol\)/);
  });

  test('the checkbox renders for both entities since C2 (the contacts list reads the flag too)', () => {
    expect(CFG).not.toMatch(/const listCol = cfEntity !== 'case' \? '' :/);
    expect(CFG).toMatch(/const listTab = cfEntityPlural\(\);/);
  });

  test('a new def starts unflagged', () => {
    expect(CFG).toMatch(/list_column: 0,\s*\/\/ custom_table_view S4/);
  });
});

describe('boot wiring', () => {
  test('loadUserContext calls casesCfInit as a live statement', () => {
    const init = fnSrc(INDEX, 'loadUserContext');
    expect(init).toMatch(/^\s*casesCfInit\(\);/m);
  });
});
