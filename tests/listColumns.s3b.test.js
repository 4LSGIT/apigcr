/**
 * tests/listColumns.s3b.test.js
 *
 * The Appts tab's column model + picker (custom_table_view S3b), the
 * Contacts/Cases gates replayed over APPTS_COLUMNS — plus what is new here:
 *   · th_extra — the Date header keeps data-sort-upcoming + title, byte-
 *     identical to the static row S3b removed;
 *   · NO ever-sorted latch: the tab defaults to the upcoming sort, whose
 *     mark is the Date label's own "⇅", so apptsColsRender runs
 *     sortMarksSync unconditionally — pinned by asserting the header is
 *     byte-identical to the old static row AFTER init ran the first sync;
 *   · the Appts action buttons: rendered by the model's Update column but
 *     BOUND in apptsRenderRows after the innerHTML write — the picker
 *     re-render path must rebind them (clicks keep reaching apptUpdate).
 * The Events half went with the Events tab (U9b-P4, 2026-11-12).
 *
 * Fixtures were frozen from the OLD positional template before any S3b
 * edit (tests/fixtures/apptColumns.s3b.json).
 *
 *   npx jest tests/listColumns.s3b.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const INDEX = read('public/index.html');
const APPT_FROZEN = JSON.parse(read('tests/fixtures/apptColumns.s3b.json'));

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

const DATE_TH_EXTRA = ' data-sort-upcoming="upcoming" title="Upcoming first → oldest first → newest first"';
const DATE_TH = (key) => `<th onclick="sort(this, '${key}')"${DATE_TH_EXTRA}>Date ⇅</th>`;

// The exact header rows the static markup carried before S3b.
const TABS = {
  appts: {
    constName: 'APPTS_COLUMNS', fnPrefix: 'appts', tabId: 'tabAppts', tableId: 'apptsTable',
    storageNs: 'appts',
    sortSelId: 'tabApptsSort', sortSel2Id: 'tabApptsSort2', rowsGlobal: 'appts',
    fetchFn: 'tabApptsGet', frozen: APPT_FROZEN, cellCount: 9,
    oldHeader: [
      '<th>ID</th>', DATE_TH('date'), '<th>Time</th>',
      `<th onclick="sort(this, 'client')">Contact Name</th>`,
      `<th onclick="sort(this, 'case')">Case</th>`,
      `<th onclick="sort(this, 'type')">Appt Type</th>`,
      `<th onclick="sort(this, 'status')">Status</th>`,
      `<th onclick="sort(this, 'with')">With</th>`,
      '<th>Update</th>',
    ],
    labels: ['ID', 'Date ⇅', 'Time', 'Contact Name', 'Case', 'Appt Type', 'Status', 'With', 'Update'],
    keys: ['id', 'format_date', 'time', 'contact_name', 'case_number', 'appt_type', 'status', 'user_name', 'update'],
    hideKey: 'appt_type', hideIdx: 5, sortCol: { value: 'client', label: 'Contact Name', key: 'contact_name', idx: 3 },
    dom: `
      <input id="tabApptsButton"><div id="tabApptsLoad"></div>
      <select id="tabApptsType"><option value="__all__" selected>x</option></select>
      <div id="tabApptsStatus"></div>
      <input id="tabApptsTime" value="All"><input id="tabApptsDate1"><input id="tabApptsDate2">
      <select id="tabApptsWith"><option value="" selected>All</option></select>
      <select id="tabApptsSort" data-type="sortBy">
        <option value="upcoming" selected>Upcoming first</option><option value="client">Contact Name</option>
      </select>
      <select id="tabApptsSort2" data-type="sortDi"><option value="ASC" selected>A</option><option value="DESC">D</option></select>`,
    prelude: `var offsets = {}, appts = null, apptsLastLoad = 0;
      var tabApptsTypesLoad = () => {}, apptsStatusValues = () => [];`,
    apiBody: `({ counter: window.__rows.length, appts: JSON.parse(JSON.stringify(window.__rows)) })`,
    fns: ['apptsColsKey', 'apptsColsOrderKey', 'apptsColsVisible', 'apptsRenderRows', 'apptsColsRender',
      'apptsColsApply', 'apptsColsDialog', 'apptsColsSave', 'apptsColsInit', 'tabApptsGet'],
  },
};
// The Events tab (and its EVENTS_COLUMNS twin) was retired in U9b-P4
// (2026-11-12); the Calendar tab's picker is pinned in calendarColumns.test.js.

function page(cfg, { userId = 6, storedOff, storageThrows = false } = {}) {
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="${cfg.tabId}" class="tab-main">
    ${cfg.dom}
    <button data-type="goButton"></button>
    <table id="${cfg.tableId}"><tr></tr></table><div id="${cfg.tableId}Foot"></div>
  </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  if (storedOff != null) w.localStorage.setItem(`yc.${cfg.storageNs}.cols_off.${userId}`, storedOff);
  if (storageThrows) Object.defineProperty(w, 'localStorage', { get() { throw new Error('denied'); } });
  w.fetches = 0;
  w.__rows = cfg.frozen.rows;
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var user = ${JSON.stringify({ user: userId })};
    var YcPager = { getLimit: (k, d) => d, renderFooter(foot) { foot.textContent = 'pager'; } };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var Toast = { fire() {} };
    ${cfg.prelude}
    var apiSend = async () => { window.fetches++; if (window.__fail) throw new Error('down'); return ${cfg.apiBody}; };
    ${constSrc(INDEX, cfg.constName)}
    var ${cfg.fnPrefix}ColsVis = ${cfg.constName};
    ${cfg.fns.map((f) => fnSrc(INDEX, f)).join('\n')}
    ycColsHeadRender(E('${cfg.tableId}'), ${cfg.constName});   // the parse-time build
    ${cfg.fnPrefix}ColsInit();                                 // the loadUserContext build
    window.__go = ${cfg.fetchFn};
    window.__cols = ${cfg.constName};
    window.__vis = () => ${cfg.fnPrefix}ColsVis;
    window.__apply = ${cfg.fnPrefix}ColsApply;
    window.__save = ${cfg.fnPrefix}ColsSave;
  `);
  return w;
}

const cells = (w, cfg) => [...w.document.querySelectorAll(`#${cfg.tableId} tr`)].slice(1)
  .map((tr) => [...tr.cells].map((td) => td.innerHTML));
const heads = (w, cfg) => [...w.document.querySelectorAll(`#${cfg.tableId} th`)];
const headTexts = (w, cfg) => heads(w, cfg).map((th) => th.textContent.trim());
/* The modal's Apply, driven directly (R1) — see caseColumns.s3a. */
const setBox = (w, cfg, key, on) => {
  const checked = new Set(w.__vis().map((c) => c.key));
  if (on) checked.add(key); else checked.delete(key);
  w.__save({ orderedKeys: w.__cols.map((c) => c.key), checkedKeys: [...checked] });
};
const expectAligned = (w, cfg) => {
  const ths = heads(w, cfg).length;
  for (const r of cells(w, cfg)) expect(r.length).toBe(ths);
};
const drop = (arr, i) => arr.filter((_, n) => n !== i);
const hideAllBut = (cfg, keep) => cfg.keys.filter((k) => k !== keep).join(',');

describe.each(Object.keys(TABS))('%s — model, picker, marks', (name) => {
  const cfg = TABS[name];

  test('zero visible change: frozen cells, and the header byte-identical AFTER the first sync', async () => {
    const w = page(cfg);
    // page() already ran init → colsApply → colsRender → sortMarksSync. The
    // upcoming default's mark IS the Date label's "⇅", so the header must
    // still equal the old static row — the no-latch design's whole claim.
    expect(heads(w, cfg).map((th) => th.outerHTML)).toEqual(cfg.oldHeader);
    await w.__go(0);
    expect(cells(w, cfg)).toEqual(cfg.frozen.cells);
    expect(cfg.frozen.cells.every((r) => r.length === cfg.cellCount)).toBe(true);
    expect(w.__pwn).toBeUndefined();
    expect(w.document.querySelectorAll('img')).toHaveLength(0);
    expectAligned(w, cfg);
  });

  test('the model is well-formed: keys, labels, default_on, safe sort/th_extra shapes', () => {
    const w = page(cfg);
    expect(w.__cols.map((c) => c.key)).toEqual(cfg.keys);
    for (const c of w.__cols) {
      expect(typeof c.label).toBe('string');
      expect(c.default_on).toBe(true);
      if (c.sort != null) expect(c.sort).toMatch(/^[a-z_.]+$/);
      if (c.th_extra != null) expect(c.th_extra).toBe(DATE_TH_EXTRA);  // the one shipped value
    }
  });

  // The modal names columns without sort glyphs (ycColsDialog strips them) —
  // covered in tests/listColsModal.r1.test.js over this very model.

  test('a change saves the HIDDEN keys, re-renders in memory, never refetches', async () => {
    const w = page(cfg);
    await w.__go(0);
    expect(w.fetches).toBe(1);
    setBox(w, cfg, cfg.hideKey, false);
    expect(w.fetches).toBe(1);                              // no refetch
    expect(w.localStorage.getItem(`yc.${cfg.storageNs}.cols_off.6`)).toBe(cfg.hideKey);
    expect(w.localStorage.getItem(`yc.${cfg.storageNs}.cols_order.6`)).toBe(cfg.keys.join(','));
    expect(headTexts(w, cfg)).toEqual(drop(cfg.labels, cfg.hideIdx));
    expect(cells(w, cfg)).toEqual(cfg.frozen.cells.map((r) => r.filter((_, i) => i !== cfg.hideIdx)));
    expectAligned(w, cfg);
    setBox(w, cfg, cfg.hideKey, true);                      // and back
    expect(w.localStorage.getItem(`yc.${cfg.storageNs}.cols_off.6`)).toBe('');
    expect(cells(w, cfg)).toEqual(cfg.frozen.cells);
  });

  test('marks: a column sort paints, survives a picker change, and the upcoming mark returns', async () => {
    const w = page(cfg);
    await w.__go(0);
    const sel = w.document.getElementById(cfg.sortSelId);
    sel.value = cfg.sortCol.value;
    w.eval(`sortSelect(document.getElementById('${cfg.sortSelId}'))`);
    expect(headTexts(w, cfg)[cfg.sortCol.idx]).toBe(`${cfg.sortCol.label} ↑`);
    expect(headTexts(w, cfg)[cfg.keys.indexOf(cfg.keys.find((k, i) => cfg.labels[i] === 'Date ⇅'))])
      .toBe('Date');                                        // upcoming's ⇅ stripped
    setBox(w, cfg, cfg.hideKey, false);                     // unrelated column
    expect(headTexts(w, cfg)).toContain(`${cfg.sortCol.label} ↑`);
    setBox(w, cfg, cfg.sortCol.key, false);                 // hide the SORTED column
    expect(headTexts(w, cfg).join(' ')).not.toMatch(/[↑↓]/);
    setBox(w, cfg, cfg.sortCol.key, true);                  // unconditional sync brings it back
    expect(headTexts(w, cfg)).toContain(`${cfg.sortCol.label} ↑`);
    sel.value = 'upcoming';
    w.eval(`sortSelect(document.getElementById('${cfg.sortSelId}'))`);
    expect(headTexts(w, cfg)).toContain('Date ⇅');          // the boot state again
    expect(headTexts(w, cfg).join(' ')).not.toMatch(/[↑↓]/);
    expectAligned(w, cfg);
  });

  test('a sort chosen while its column is hidden still marks it on re-show', async () => {
    const w = page(cfg);
    await w.__go(0);
    setBox(w, cfg, cfg.sortCol.key, false);                 // hide first
    const sel = w.document.getElementById(cfg.sortSelId);
    sel.value = cfg.sortCol.value;
    w.eval(`sortSelect(document.getElementById('${cfg.sortSelId}'))`);
    expect(headTexts(w, cfg).join(' ')).not.toMatch(/[↑↓]/);
    setBox(w, cfg, cfg.sortCol.key, true);                  // sync reads the selects
    expect(headTexts(w, cfg)).toContain(`${cfg.sortCol.label} ↑`);
  });

  test('stored choice: unknown keys drop, hide-all falls back, empty save falls back, per-user', () => {
    const w1 = page(cfg, { storedOff: `${cfg.hideKey},retired_column` });
    expect(headTexts(w1, cfg)).toEqual(drop(cfg.labels, cfg.hideIdx));
    const w2 = page(cfg, { storedOff: cfg.keys.join(',') });
    expect(headTexts(w2, cfg)).toEqual(cfg.labels);         // default_on fallback
    // The dialog refuses zero checked boxes (listColsModal.r1); the save's
    // own fallback holds behind it.
    const w3 = page(cfg);
    w3.__save({ orderedKeys: cfg.keys, checkedKeys: ['retired_column'] });
    expect(headTexts(w3, cfg)).toEqual(cfg.labels);
    const other = page(cfg, { userId: 22 });
    other.localStorage.setItem(`yc.${cfg.storageNs}.cols_off.6`, hideAllBut(cfg, cfg.keys[0]));
    other.eval(`${cfg.fnPrefix}ColsApply()`);
    expect(headTexts(other, cfg)).toEqual(cfg.labels);      // another user's pref ignored
  });

  test('a stored cols_order reorders headers AND cells together', () => {
    const w = page(cfg);
    const rev = [...cfg.keys].reverse();
    w.localStorage.setItem(`yc.${cfg.storageNs}.cols_order.6`, rev.join(','));
    w.eval(`${cfg.fnPrefix}ColsApply()`);
    expect(w.__vis().map((c) => c.key)).toEqual(rev);
    expect(headTexts(w, cfg)).toEqual([...cfg.labels].reverse());
  });

  test("the modal's Apply with a REORDERED answer repaints headers and cells in that order", async () => {
    // The save must follow the dialog's orderedKeys, not the model order —
    // the review's surviving mutant on the three twin tabs.
    const w = page(cfg);
    await w.__go(0);
    const rev = [...cfg.keys].reverse();
    w.__save({ orderedKeys: rev, checkedKeys: [...cfg.keys] });
    expect(headTexts(w, cfg)).toEqual([...cfg.labels].reverse());
    const firstRow = cells(w, cfg)[0];
    const straight = cfg.frozen.cells[0];
    expect(firstRow).toEqual([...straight].reverse());
    expect(w.localStorage.getItem(`yc.${cfg.storageNs}.cols_order.6`)).toBe(rev.join(','));
    expectAligned(w, cfg);
  });

  test("another window's cols_order save re-applies through the storage listener", async () => {
    const w = page(cfg);
    await w.__go(0);
    const rev = [...cfg.keys].reverse();
    w.localStorage.setItem(`yc.${cfg.storageNs}.cols_order.6`, rev.join(','));
    w.dispatchEvent(new w.StorageEvent('storage', { key: `yc.${cfg.storageNs}.cols_order.6` }));
    expect(headTexts(w, cfg)).toEqual([...cfg.labels].reverse());
    expectAligned(w, cfg);
  });

  test('the footer carries the Columns entry point on success, empty and error outcomes', async () => {
    const w = page(cfg);
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

  test('a column a later slice ADDS is visible without touching the pref', () => {
    const w = page(cfg, { storedOff: cfg.hideKey });
    w.__cols.push({ key: 'cf_new', label: 'New', default_on: true, render: () => '' });
    w.__apply();
    expect(w.__vis().some((c) => c.key === 'cf_new')).toBe(true);
    expect(headTexts(w, cfg)).toContain('New');
  });

  test('the screen follows the click even when storage throws', async () => {
    const w = page(cfg, { storageThrows: true });
    await w.__go(0);
    setBox(w, cfg, cfg.hideKey, false);
    expect(headTexts(w, cfg)).toEqual(drop(cfg.labels, cfg.hideIdx));
    expectAligned(w, cfg);
  });

  test('a failed fetch clears the cache AND rows a mid-flight picker change painted', async () => {
    const w = page(cfg);
    await w.__go(0);
    let reject;
    w.__hang = new Promise((res, rej) => { reject = rej; });
    w.eval('apiSend = () => window.__hang');
    const pending = w.__go(0);
    setBox(w, cfg, cfg.hideKey, false);                     // race: redraws the old page
    expect(cells(w, cfg)).toHaveLength(cfg.frozen.rows.length);
    reject(new Error('down'));
    await pending;
    expect(cells(w, cfg)).toEqual([]);                      // the catch cleared them
    expectAligned(w, cfg);
  });

  test('an EMPTY fetch replaces the cache — a picker toggle cannot resurrect the page', async () => {
    // The S3b review blocker: filter to Scheduled, the last row changes
    // status, the refetch returns nothing — a later column toggle must not
    // repaint the old rows (live action buttons bound to stale statuses).
    const w = page(cfg);
    await w.__go(0);                                        // a page on screen
    w.__rows = [];
    await w.__go(0);                                        // the empty result
    expect(cells(w, cfg)).toEqual([]);
    setBox(w, cfg, cfg.hideKey, false);                     // the resurrect attempt
    expect(cells(w, cfg)).toEqual([]);
    expectAligned(w, cfg);
  });

  test('a mid-flight picker change does not outlive an EMPTY response either', async () => {
    const w = page(cfg);
    await w.__go(0);
    let resolve;
    w.__hang = new Promise((res) => { resolve = res; });
    w.eval('apiSend = () => window.__hang');
    const pending = w.__go(0);
    setBox(w, cfg, cfg.hideKey, false);                     // race: redraws the old page
    expect(cells(w, cfg)).toHaveLength(cfg.frozen.rows.length);
    resolve({ counter: 0, total: 0, data: [], appts: [] });  // both tabs' empty shape
    await pending;
    expect(cells(w, cfg)).toEqual([]);                      // the empty branch cleared them
    expectAligned(w, cfg);
  });

  test('a reset cache ("" after logout) cannot leave rows under rebuilt headers', async () => {
    const w = page(cfg);
    await w.__go(0);                                        // rows on screen
    w.eval(`${cfg.rowsGlobal} = ""`);                       // the logout reset shape
    setBox(w, cfg, cfg.hideKey, false);
    expect(cells(w, cfg)).toEqual([]);                      // cleared, not skipped
    expectAligned(w, cfg);
  });

  test('loadUserContext calls the init as a live statement', () => {
    const init = fnSrc(INDEX, 'loadUserContext');
    expect(init).toMatch(new RegExp(`^\\s*${cfg.fnPrefix}ColsInit\\(\\);$`, 'm'));
  });
});

describe('appts action buttons — bound on every render path', () => {
  const cfg = TABS.appts;

  test('fixture button counts per status, and clicks reach apptUpdate after a PICKER re-render', async () => {
    const w = page(cfg);
    w.__calls = [];
    w.eval('apptUpdate = (...a) => window.__calls.push(a);');
    await w.__go(0);
    const counts = [...w.document.querySelectorAll('#apptsTable tr')].slice(1)
      .map((tr) => tr.querySelectorAll('button[data-appt-act]').length);
    expect(counts).toEqual(cfg.frozen.btnCounts);
    setBox(w, cfg, 'time', false);                          // picker re-render path
    const row = w.document.querySelectorAll('#apptsTable tr')[1];
    const btn = row.querySelector('button[data-appt-act="Attended"]');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    const a = cfg.frozen.rows[0];
    expect(w.__calls).toEqual([[a.id, 'Attended', null, null, String(a.status)]]);
    expect(btn.hasAttribute('onclick')).toBe(false);        // listeners, never onclick source
  });

  test('hiding the Update column removes the buttons; re-showing rebinds them', async () => {
    const w = page(cfg);
    w.__calls = [];
    w.eval('apptUpdate = (...a) => window.__calls.push(a);');
    await w.__go(0);
    setBox(w, cfg, 'update', false);
    expect(w.document.querySelectorAll('#apptsTable button')).toHaveLength(0);
    setBox(w, cfg, 'update', true);
    const btn = w.document.querySelectorAll('#apptsTable tr')[1].querySelector('button[data-appt-act="Attended"]');
    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    expect(w.__calls).toHaveLength(1);
  });
});

// Evaluate the WHOLE appts <script> block, as shipped, against
// the real table markup — the real gate for the two top-level build calls.
function evalBlock(ycStub) {
  const declAt = INDEX.indexOf('const APPTS_COLUMNS');
  const blockStart = INDEX.lastIndexOf('<script>', declAt) + '<script>'.length;
  const block = INDEX.slice(blockStart, INDEX.indexOf('</script>', declAt));
  const markup = ['apptsTable'].map((id) => {
    const at = INDEX.indexOf(`<table id="${id}"`);
    return INDEX.slice(at, INDEX.indexOf('</table>', at) + '</table>'.length);
  }).join('\n');
  const jsd = new JSDOM(`<!DOCTYPE html><body>
    <div id="tabAppts" class="tab-main">${markup}
      <select id="tabApptsSort" data-type="sortBy"><option value="upcoming" selected>U</option></select>
      <select id="tabApptsSort2" data-type="sortDi"><option value="ASC" selected>A</option></select>
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
      var user = { user: 6 }, offsets = {}, appts = null;
      var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
      var exportListCsv = () => {}, csvFilterOf = (p) => p;
      var Toast = { fire() {} };
      var apiSend = async () => ({ total: 0, counter: 0, data: [], appts: [] });
      function openMainTab() {}
      function currentMainTabId() { return ''; }
      var tabApptsTypesLoad = () => {}, apptsStatusValues = () => [];
      ${block}
    `);
  } catch (e) { threw = e; }
  const ths = (id) => [...w.document.querySelectorAll(`#${id} th`)].map((th) => th.outerHTML);
  return { w, ths, threw };
}

describe('the shipped block', () => {
  test('builds both headers at parse time', () => {
    const { ths, threw } = evalBlock('() => {}');
    expect(threw).toBeNull();
    expect(ths('apptsTable')).toEqual(TABS.appts.oldHeader);
  });

  test('a sync-bus registration failure cannot leave either tab headerless', () => {
    const { ths, threw } = evalBlock("() => { throw new Error('sync regression'); }");
    expect(threw).not.toBeNull();
    expect(ths('apptsTable')).toEqual(TABS.appts.oldHeader);
  });

  test.each([
    ['appts', 'apptsTable', 'appt_type', 5],
  ])("another window's save re-applies: %s (the shipped storage listener)", (name, tableId, hideKey, hideIdx) => {
    const cfg = TABS[name];
    const { w, threw } = evalBlock('() => {}');
    expect(threw).toBeNull();
    w.eval(`${cfg.fnPrefix}ColsInit()`);
    w[cfg.rowsGlobal] = cfg.frozen.rows.slice(0, 1);        // a page on screen
    w.eval(`${cfg.fnPrefix}RenderRows()`);
    w.localStorage.setItem(`yc.${cfg.storageNs}.cols_off.6`, hideKey);
    w.dispatchEvent(new w.StorageEvent('storage', { key: `yc.${cfg.storageNs}.cols_off.6` }));
    expect([...w.document.querySelectorAll(`#${tableId} th`)].map((t) => t.textContent.trim()))
      .toEqual(drop(cfg.labels, hideIdx));
    const row = w.document.querySelectorAll(`#${tableId} tr`)[1];
    expect(row.cells).toHaveLength(cfg.keys.length - 1);    // rows follow in the same apply
    expect(row.cells[hideIdx].innerHTML).toBe(cfg.frozen.cells[0][hideIdx + 1]);
  });
});

describe('the pickers left the filter bars (R1)', () => {
  test.each([
    ['appts', 'tabAppts', 'tabApptsColsMenu', 'apptsTable'],
  ])('%s: no Columns dropdown in the bar; the counter still counts a real filter', (name, tabId, menuId, tableId) => {
    const tabAt = INDEX.indexOf(`<div id="${tabId}"`);
    const bar = INDEX.slice(INDEX.indexOf('<div class="yc-filters">', tabAt),
      INDEX.indexOf(`<table id="${tableId}"`, tabAt));
    // The dropdown and its menu are gone — the modal (footer button) is the
    // only picker now.
    expect(bar).not.toContain(menuId);
    const jsd = new JSDOM(`<!DOCTYPE html><body><div id="${tabId}">${bar}
      <table id="${tableId}"><tr></tr></table></div></body>`,
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    const w = jsd.window;
    w.eval(`
      window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
      ${SCRIPTS}
      window.__active = (sel) => ycFiltersActive(document.querySelector(sel));
    `);
    expect(w.__active('.yc-filters')).toBe(0);
    const date1 = w.document.querySelector('#tabApptsDate1');
    w.document.querySelector('#tabApptsTime').value = 'After';
    date1.value = '2026-11-01';
    expect(w.__active('.yc-filters')).toBeGreaterThan(0);   // a real filter still does
  });
});
