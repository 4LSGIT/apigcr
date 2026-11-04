/**
 * tests/contactColumns.c2.test.js
 *
 * Custom-field columns in the Contacts tab (custom_table_view C2 client) —
 * the Cases tab's S4 feature mirrored; tests/caseColumns.s4.test.js is the
 * template and this file asserts the same contract on the contacts side:
 *   1. the storage extension — cols_off keeps the hidden default columns,
 *      cols_on governs the default_on:false cf columns; old off-only stored
 *      values keep working; unknown cols_on keys survive rewrites; the
 *      storage listener reacts to both keys;
 *   2. the registry append — flagged ACTIVE CONTACT defs become picker
 *      entries (inactive/unflagged/hostile-key/CASE-entity defs never do; a
 *      hostile label is escaped); the Order By select gains scalar cf
 *      options; init failure or a second init cannot hurt the tab;
 *   3. rendering per type through ycCfCellText;
 *   4. reveal-refetch — ONE silent refetch carrying params.cf, the boot
 *      race, the hidden-sort ride, keptOn under a failed defs fetch;
 *   5. the Fields editor renders the checkbox for BOTH entities now.
 *
 *   npx jest tests/contactColumns.c2.test.js
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
  { id: 1, entity: 'contact', field_key: 'cf_lang', label: 'Language', field_type: 'select',
    options: [{ value: 'en', label: 'English' }], list_column: 1, active: 1 },
  { id: 2, entity: 'contact', field_key: 'cf_since', label: 'Client Since', field_type: 'date', list_column: 1, active: 1 },
  { id: 3, entity: 'contact', field_key: 'cf_vip', label: 'VIP?', field_type: 'boolean', list_column: 1, active: 1 },
  { id: 4, entity: 'contact', field_key: 'cf_ctags', label: 'CTags', field_type: 'multiselect', list_column: 1, active: 1 },
  { id: 5, entity: 'contact', field_key: 'cf_retired', label: 'Retired', field_type: 'text', list_column: 1, active: 0 },
  { id: 6, entity: 'contact', field_key: 'cf_unflagged', label: 'Unflagged', field_type: 'text', list_column: 0, active: 1 },
  { id: 7, entity: 'contact', field_key: 'cf_bad`key', label: 'Hostile Key', field_type: 'text', list_column: 1, active: 1 },
  { id: 8, entity: 'contact', field_key: 'cf_hostile', label: '<img src=x onerror="window.__pwn=1">', field_type: 'text', list_column: 1, active: 1 },
  // The entity axis: a flagged CASE def must never join the CONTACTS picker.
  { id: 9, entity: 'case', field_key: 'cf_court', label: 'Court', field_type: 'select', list_column: 1, active: 1 },
];
const CF_VALUES = {
  101: { cf_lang: 'en', cf_since: '2026-11-20', cf_vip: 'true', cf_ctags: '["a","z"]', cf_hostile: 'v' },
  102: { cf_lang: null, cf_since: null, cf_vip: null, cf_ctags: null, cf_hostile: null },
};
const ROWS = [
  { contact_id: 101, contact_type: 'Client', contact_name: 'Pat Smith', contact_fname: 'Pat',
    contact_lname: 'Smith', contact_phone: '', contact_email: '', contact_address: '',
    contact_city: '', contact_state: '', contact_zip: '', contact_tags: '', dob: '', cases: [] },
  { contact_id: 102, contact_type: 'Client', contact_name: 'Abe Jones', contact_fname: 'Abe',
    contact_lname: 'Jones', contact_phone: '', contact_email: '', contact_address: '',
    contact_city: '', contact_state: '', contact_zip: '', contact_tags: '', dob: '', cases: [] },
];

const PICKER_FNS = ['contactsRoleValues', 'contactsColsKey', 'contactsColsOnKey', 'contactsCfEnsure',
  'contactsColsVisible', 'contactsRenderRows', 'contactsColsRender', 'contactsColsApply',
  'contactsColsChanged', 'contactsColsInit', 'contactsCfColumns', 'contactsCfInit', 'tabContactsGet'];

function page({ userId = 6, storedOff, storedOn, defs = DEFS } = {}) {
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabContacts" class="tab-main">
    <input id="tabContactsQuery"><div id="tabContactsLoad"></div>
    <div id="tabContactsRole"></div>
    <details id="tabContactsCols"><summary><span id="tabContactsColsLabel">All</span></summary>
      <div id="tabContactsColsMenu"></div></details>
    <select id="tabContactsSort" data-type="sortBy">
      <option value="contact_lname" selected>Last</option>
    </select>
    <select id="tabContactsSort2" data-type="sortDi"><option value="ASC" selected>A</option></select>
    <button data-type="goButton"></button>
    <table id="contactsTable"><tr></tr></table><div id="contactsTableFoot"></div>
  </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  if (storedOff != null) w.localStorage.setItem(`yc.contacts.cols_off.${userId}`, storedOff);
  if (storedOn != null) w.localStorage.setItem(`yc.contacts.cols_on.${userId}`, storedOn);
  w.__defs = defs;
  w.__rows = ROWS;
  w.__cfValues = CF_VALUES;
  w.listFetches = 0;
  w.lastListParams = null;
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var offsets = {}, contacts = null;
    var user = ${JSON.stringify({ user: userId })};
    var YcPager = { getLimit: (k, d) => d, renderFooter(foot) { foot.textContent = 'pager'; } };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var Toast = { fire() {} };
    // The honest server mimic: defs from the registry; list rows carry
    // exactly the cf keys params.cf asked for, from the per-contact map.
    var apiSend = async (url, method, params) => {
      if (url === '/api/field-defs') {
        if (window.__defsFail) throw new Error('defs down');
        return { defs: window.__defs };
      }
      window.listFetches++;
      // Bounded fuse: a mutant that breaks the ensure/fetched handshake
      // (e.g. contactsCfFetched never recorded) loops ensure→fetch→ensure as
      // pure microtasks, which starves jest's own timers — the run WEDGES
      // instead of failing. The throw lands in tabContactsGet's catch, which
      // nulls the cache; ensure's !contacts guard then stops the loop, and
      // the fetch-count assertions fail loudly.
      if (window.listFetches > 25) throw new Error('refetch runaway');
      window.lastListParams = params;
      const cfKeys = params && params.cf ? JSON.parse(params.cf) : [];
      const rows = window.__rows.map((r) => {
        const out = JSON.parse(JSON.stringify(r));
        for (const k of cfKeys) out[k] = (window.__cfValues[r.contact_id] || {})[k] ?? null;
        return out;
      });
      return { total: rows.length, contacts: rows };
    };
    ${constSrc(INDEX, 'CONTACT_COLUMNS')}
    ${constLine(INDEX, 'CONTACTS_CF_KEY_RE')}
    var contactsColsVis = CONTACT_COLUMNS, contactsEverSorted = false, contactsCfFetched = [];
    ${PICKER_FNS.map((f) => fnSrc(INDEX, f)).join('\n')}
    ycColsHeadRender(E('contactsTable'), CONTACT_COLUMNS);   // the parse-time build
    contactsColsInit();                                      // the loadUserContext builds
    window.__cfInit = contactsCfInit;
    window.__go = tabContactsGet;
    window.__cols = CONTACT_COLUMNS;
    window.__vis = () => contactsColsVis;
  `);
  return w;
}
const cfReady = async (w) => { await w.__cfInit(); };

const cells = (w) => [...w.document.querySelectorAll('#contactsTable tr')].slice(1)
  .map((tr) => [...tr.cells].map((td) => td.innerHTML));
const headTexts = (w) => [...w.document.querySelectorAll('#contactsTable th')].map((th) => th.textContent.trim());
const boxFor = (w, key) => [...w.document.querySelectorAll('#tabContactsColsMenu input')].find((b) => b.value === key);
const setBox = (w, key, on) => { const b = boxFor(w, key); b.checked = on; b.dispatchEvent(new w.Event('change', { bubbles: true })); };
const label = (w) => w.document.getElementById('tabContactsColsLabel').textContent;
const settle = (w) => new Promise((r) => w.setTimeout(r, 0));
const STATIC_N = 7;

describe('the registry append', () => {
  test('flagged active CONTACT defs join the picker, hidden by default; the rest never do', async () => {
    const w = page();
    await cfReady(w);
    const boxes = [...w.document.querySelectorAll('#tabContactsColsMenu input')].map((b) => b.value);
    expect(boxes).toHaveLength(STATIC_N + 5);           // lang, since, vip, ctags, hostile-label
    for (const k of ['cf_lang', 'cf_since', 'cf_vip', 'cf_ctags', 'cf_hostile']) expect(boxes).toContain(k);
    for (const k of ['cf_retired', 'cf_unflagged', 'cf_bad`key', 'cf_court']) expect(boxes).not.toContain(k);
    expect(headTexts(w)).toHaveLength(STATIC_N);        // all cf hidden by default
    expect(label(w)).toBe(`${STATIC_N} of ${STATIC_N + 5}`);
    expect(w.__pwn).toBeUndefined();                    // hostile label never executed
    expect(w.document.querySelectorAll('#tabContactsColsMenu img')).toHaveLength(0);
  });

  test('the Order By select gains scalar cf options only, labeled from the def', async () => {
    const w = page();
    await cfReady(w);
    const opts = [...w.document.getElementById('tabContactsSort').options].map((o) => [o.value, o.textContent]);
    expect(opts).toContainEqual(['cf_lang', 'Language']);
    expect(opts).toContainEqual(['cf_since', 'Client Since']);
    expect(opts.map(([v]) => v)).not.toContain('cf_ctags');   // multiselect never sorts
  });

  test('a defs failure or an empty registry costs only the cf columns', async () => {
    const w = page();
    w.__defsFail = true;
    await cfReady(w);
    expect(headTexts(w)).toHaveLength(STATIC_N);
    expect(label(w)).toBe('All');
    await w.__go(0);
    expect(cells(w)).toHaveLength(2);                   // the tab still works
    const w2 = page({ defs: [] });
    await cfReady(w2);
    expect(label(w2)).toBe('All');
  });

  test('a second init is a no-op — no duplicate columns', async () => {
    const w = page();
    await cfReady(w);
    await cfReady(w);
    expect(w.__cols.filter((c) => c.key === 'cf_lang')).toHaveLength(1);
  });

  test('a hostile label lands as text in the generated header', async () => {
    const w = page({ storedOn: 'cf_hostile' });
    await cfReady(w);
    expect(headTexts(w)).toContain('<img src=x onerror="window.__pwn=1">');
    expect(w.document.querySelectorAll('#contactsTable img')).toHaveLength(0);
    expect(w.__pwn).toBeUndefined();
  });
});

describe('the storage extension', () => {
  test('turning a cf column on writes cols_on; default columns keep cols_off; both restore', async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    setBox(w, 'cf_lang', true);
    await settle(w);
    expect(w.localStorage.getItem('yc.contacts.cols_on.6')).toBe('cf_lang');
    expect(w.localStorage.getItem('yc.contacts.cols_off.6')).toBe('');
    setBox(w, 'dob', false);
    expect(w.localStorage.getItem('yc.contacts.cols_off.6')).toBe('dob');
    expect(w.localStorage.getItem('yc.contacts.cols_on.6')).toBe('cf_lang');
    const again = page({ storedOff: 'dob', storedOn: 'cf_lang' });
    await cfReady(again);
    expect(headTexts(again)).toContain('Language');
    expect(headTexts(again)).not.toContain('Date of Birth');
  });

  test('an old off-only stored value keeps working; unknown cols_on keys drop from the screen', async () => {
    const w = page({ storedOff: 'dob' });                 // pre-C2 shape, no cols_on
    await cfReady(w);
    expect(headTexts(w)).toHaveLength(STATIC_N - 1);
    expect(headTexts(w)).not.toContain('Date of Birth');
    const w2 = page({ storedOn: 'cf_gone,cf_lang' });     // a retired cf key lingers
    await cfReady(w2);
    expect(headTexts(w2)).toContain('Language');
    expect(headTexts(w2)).toHaveLength(STATIC_N + 1);
  });

  test("another window's cols_on save re-applies here and fetches the data", async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    const before = w.listFetches;
    w.localStorage.setItem('yc.contacts.cols_on.6', 'cf_lang');
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.contacts.cols_on.6' }));
    await settle(w);
    expect(headTexts(w)).toContain('Language');
    expect(w.listFetches).toBe(before + 1);              // the reveal-refetch
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_lang']);
  });
});

describe('rendering per type (D4)', () => {
  test('select VALUE, house date, boolean Yes/blank, multiselect joined, null blank', async () => {
    const w = page({ storedOn: 'cf_lang,cf_since,cf_vip,cf_ctags' });
    await cfReady(w);
    await w.__go(0);
    const h = headTexts(w);
    const row1 = cells(w)[0]; const row2 = cells(w)[1];
    const at = (lbl) => h.indexOf(lbl);
    expect(row1[at('Language')]).toBe('en');             // the stored VALUE, not the label
    expect(row1[at('Client Since')]).toBe('Nov. 20, 2026');
    expect(row1[at('VIP?')]).toBe('Yes');
    expect(row1[at('CTags')]).toBe('a, z');
    expect(row2[at('Language')]).toBe('');
    expect(row2[at('VIP?')]).toBe('');
  });

  test('the view export carries the visible cf columns (contacts exports the vis set itself)', async () => {
    const w = page({ storedOn: 'cf_lang,cf_since' });
    await cfReady(w);
    await w.__go(0);
    const view = w.__vis();
    const lang = view.find((c) => c.key === 'cf_lang');
    const since = view.find((c) => c.key === 'cf_since');
    expect(lang).toBeDefined();
    expect(lang.csv({ ...ROWS[0], ...CF_VALUES[101] })).toBe('en');
    expect(since.csv({ ...ROWS[0], ...CF_VALUES[101] })).toBe('Nov. 20, 2026');
  });
});

describe('the reveal-refetch', () => {
  test('revealing an unfetched cf column fetches ONCE with params.cf; everything else never fetches', async () => {
    const w = page();
    await cfReady(w);
    await w.__go(0);
    expect(w.listFetches).toBe(1);
    expect(w.lastListParams.cf).toBeUndefined();         // default request byte-identical
    setBox(w, 'cf_lang', true);
    await settle(w);
    expect(w.listFetches).toBe(2);                       // the one silent refetch
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_lang']);
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Language')]).toBe('en');
    setBox(w, 'cf_lang', false);                         // hide: render only
    await settle(w);
    expect(w.listFetches).toBe(2);
    setBox(w, 'cf_lang', true);                          // re-show: data already on hand
    await settle(w);
    expect(w.listFetches).toBe(2);
    expect(cells(w)[0][headTexts(w).indexOf('Language')]).toBe('en');
    setBox(w, 'dob', false);                             // a static toggle never fetches
    await settle(w);
    expect(w.listFetches).toBe(2);
  });

  test('the boot race: defs landing while the first fetch is in flight cannot leave the column blank', async () => {
    const w = page({ storedOn: 'cf_lang' });
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
    expect(headTexts(w)).toContain('Language');          // the grown header is up
    releaseList();
    await boot;
    await settle(w);
    await settle(w);                                     // the follow-up fetch settles
    expect(w.listFetches).toBe(2);                       // exactly one ensure refetch
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Language')]).toBe('en');  // never left blank
  });

  test('Order By a HIDDEN cf column still rides the key — the sort reaches the server', async () => {
    const w = page();
    await cfReady(w);
    const sel = w.document.getElementById('tabContactsSort');
    sel.value = 'cf_lang';                               // Language column stays hidden
    await w.__go(0);
    expect(w.lastListParams.sort_by).toBe('cf_lang');
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_lang']);  // selected, so honored
    sel.value = 'contact_lname';                         // a static sort adds nothing
    await w.__go(0);
    expect(w.lastListParams.cf).toBeUndefined();
  });

  test('a picker change before the defs arrive cannot erase the stored cf choice', async () => {
    const w = page({ storedOn: 'cf_lang' });
    w.__defsFail = true;
    await cfReady(w);                                    // static model only
    setBox(w, 'dob', false);                             // unrelated toggle
    expect(w.localStorage.getItem('yc.contacts.cols_on.6')).toBe('cf_lang');  // kept
  });

  test('before any fetch, turning a cf column on fetches nothing (first open will)', async () => {
    const w = page();
    await cfReady(w);
    setBox(w, 'cf_lang', true);
    await settle(w);
    expect(w.listFetches).toBe(0);
    await w.__go(0);                                     // the first open carries it
    expect(JSON.parse(w.lastListParams.cf)).toEqual(['cf_lang']);
  });
});

describe('hostile cf VALUES land as text', () => {
  test('a stored value carrying markup is escaped by the cf render', async () => {
    const w = page({ storedOn: 'cf_lang' });
    w.__cfValues = { ...CF_VALUES, 101: { ...CF_VALUES[101], cf_lang: '<img src=x onerror="window.__pwn=3">' } };
    await cfReady(w);
    await w.__go(0);
    const h = headTexts(w);
    expect(cells(w)[0][h.indexOf('Language')]).toContain('&lt;img');
    expect(w.document.querySelectorAll('#contactsTable img')).toHaveLength(0);
    expect(w.__pwn).toBeUndefined();
  });
});

// The Fields editor: C2 opens the checkbox to both entities, hint named for
// the tab the entity feeds (source pins, the customFields.s6 precedent).
describe('the Fields editor renders list_column for both entities (C2)', () => {
  const CFG = read('public/caseconfig/fields.html');

  test('the checkbox renders unconditionally, hint names the entity tab', () => {
    expect(CFG).not.toMatch(/const listCol = cfEntity !== 'case' \? '' :/);
    expect(CFG).toMatch(/const listTab = cfEntityPlural\(\);/);
    expect(CFG).toMatch(/Shows this field in the \$\{listTab\} tab's Columns picker/);
  });
});

describe('boot wiring', () => {
  test('loadUserContext calls contactsCfInit as a live statement', () => {
    const init = fnSrc(INDEX, 'loadUserContext');
    expect(init).toMatch(/^\s*contactsCfInit\(\);/m);
  });
});
