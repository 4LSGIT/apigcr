/**
 * tests/contactColumns.s2.test.js
 *
 * The Contacts column picker (S2) over the S1 model:
 *   1. the menu builds from CONTACT_COLUMNS, default = every default_on
 *      column, and the DEFAULT render still equals the frozen pre-S1 cells
 *      (tests/fixtures/contactColumns.s1.json) — the picker changes nothing
 *      until used, including no sort mark at boot;
 *   2. headers and rows render from ONE in-memory set (contactsColsVis) —
 *      never from storage per fetch, the review-caught blocker: another
 *      window's save plus a silent refetch here must not put data under the
 *      wrong headers. A change saves the HIDDEN keys per browser + per user
 *      (yc.contacts.cols_off.<uid>) so columns a later slice adds show up
 *      automatically, re-renders from memory with NO refetch, and the
 *      screen follows the click even when storage throws;
 *   3. sort marks survive a picker change, including hiding and re-showing
 *      the sorted column, and never appear at boot;
 *   4. unknown stored keys drop; a value hiding everything falls back; the
 *      last checked box cannot be cleared; another window's storage event
 *      re-applies here (wired at the top level of the shipped block);
 *   5. the shipped filter-bar markup keeps the picker out of the filter
 *      counter (data-nocount); a failed fetch nulls the row cache so a
 *      picker change cannot redraw a stale page; loadUserContext wires
 *      contactsColsInit.
 *
 *   npx jest tests/contactColumns.s2.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const INDEX = read('public/index.html');
const FROZEN = JSON.parse(read('tests/fixtures/contactColumns.s1.json'));

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

const ALL_KEYS = ['contact_id', 'contact_name', 'contact_phone', 'contact_email', 'contact_address', 'cases', 'dob'];
const hideAllBut = (keep) => ALL_KEYS.filter((k) => k !== keep).join(',');

const PICKER_FNS = ['contactsRoleValues', 'contactsColsKey', 'contactsColsOnKey', 'contactsColsOrderKey',
  'contactsCfEnsure', 'contactsColsVisible', 'contactsRenderRows', 'contactsColsRender', 'contactsColsApply',
  'contactsColsDialog', 'contactsColsSave', 'contactsColsInit', 'tabContactsGet'];

function page({ userId = 6, storedOff, storageThrows = false, failFetch = false } = {}) {
  const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabContacts" class="tab-main">
    <input id="tabContactsQuery"><div id="tabContactsLoad"></div>
    <div id="tabContactsRole"></div>
    <select id="tabContactsSort" data-type="sortBy">
      <option value="contact_lname">Last</option><option value="contact_dob">DOB</option>
    </select>
    <select id="tabContactsSort2" data-type="sortDi">
      <option value="ASC">A</option><option value="DESC">D</option>
    </select>
    <button data-type="goButton"></button>
    <table id="contactsTable"><tr></tr></table><div id="contactsTableFoot"></div>
  </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  if (storedOff != null) w.localStorage.setItem(`yc.contacts.cols_off.${userId}`, storedOff);
  if (storageThrows) Object.defineProperty(w, 'localStorage', { get() { throw new Error('denied'); } });
  w.fetches = 0;
  w.__rows = FROZEN.rows;
  w.__fail = failFetch;
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var offsets = {}, contacts = null;
    var user = ${JSON.stringify({ user: userId })};
    var YcPager = { getLimit: (k, d) => d, renderFooter(foot) { foot.textContent = 'pager'; } };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var Toast = { fire() {} };
    var apiSend = async () => {
      window.fetches++;
      if (window.__fail) throw new Error('down');
      return { total: window.__rows.length, contacts: window.__rows };
    };
    ${constSrc(INDEX, 'CONTACT_COLUMNS')}
    var contactsColsVis = CONTACT_COLUMNS, contactsEverSorted = false, contactsCfFetched = [];
    ${PICKER_FNS.map((f) => fnSrc(INDEX, f)).join('\n')}
    ycColsHeadRender(E('contactsTable'), CONTACT_COLUMNS);   // the parse-time build
    contactsColsInit();                                      // the loadUserContext build
    window.__go = tabContactsGet;
    window.__cols = CONTACT_COLUMNS;
    window.__vis = () => contactsColsVis;
    window.__apply = contactsColsApply;
    window.__save = contactsColsSave;
  `);
  return w;
}

const cells = (w) => [...w.document.querySelectorAll('#contactsTable tr')].slice(1)
  .map((tr) => [...tr.cells].map((td) => td.innerHTML));
const headTexts = (w) => [...w.document.querySelectorAll('#contactsTable th')].map((th) => th.textContent.trim());
/* The modal's Apply, driven directly (R1) — see caseColumns.s3a. */
const setBox = (w, key, on) => {
  const checked = new Set(w.__vis().map((c) => c.key));
  if (on) checked.add(key); else checked.delete(key);
  w.__save({ orderedKeys: w.__cols.map((c) => c.key), checkedKeys: [...checked] });
};
// Headers and rows must always agree — the review-caught blocker's invariant.
const expectAligned = (w) => {
  const ths = w.document.querySelectorAll('#contactsTable th').length;
  for (const r of cells(w)) expect(r.length).toBe(ths);
};

describe('default state — the picker changes nothing until used', () => {
  test('all columns on by default, no boot marks, frozen cells', async () => {
    const w = page();
    expect(w.__vis().map((c) => c.key)).toEqual(ALL_KEYS);
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);
    await w.__go(0);
    expect(cells(w)).toEqual(FROZEN.cells);
    expectAligned(w);
  });
});

describe('choosing columns', () => {
  test('a change saves the HIDDEN keys, re-renders in memory, never refetches', async () => {
    const w = page();
    await w.__go(0);
    expect(w.fetches).toBe(1);
    setBox(w, 'contact_phone', false);
    expect(w.fetches).toBe(1);                              // no refetch
    expect(w.localStorage.getItem('yc.contacts.cols_off.6')).toBe('contact_phone');
    expect(w.localStorage.getItem('yc.contacts.cols_order.6')).toBe(ALL_KEYS.join(','));
    expect(headTexts(w)).toEqual(['ID', 'Name', 'Email', 'Address', 'Cases', 'Date of Birth']);
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 2)));
    expectAligned(w);
    setBox(w, 'contact_phone', true);                       // and back
    expect(w.localStorage.getItem('yc.contacts.cols_off.6')).toBe('');
    expect(cells(w)).toEqual(FROZEN.cells);
  });

  test('sort marks survive a picker change — hiding and re-showing the sorted column too', async () => {
    const w = page();
    await w.__go(0);
    w.document.getElementById('tabContactsSort').value = 'contact_dob';
    w.document.getElementById('tabContactsSort2').value = 'ASC';
    w.eval(`sortSelect(document.getElementById('tabContactsSort'))`);
    expect(headTexts(w).at(-1)).toBe('Date of Birth ↑');
    setBox(w, 'contact_phone', false);                      // unrelated column
    expect(headTexts(w).at(-1)).toBe('Date of Birth ↑');
    setBox(w, 'dob', false);                                // hide the SORTED column
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);
    setBox(w, 'dob', true);                                 // its mark comes back
    expect(headTexts(w).at(-1)).toBe('Date of Birth ↑');
    expectAligned(w);
  });

  test('a sort chosen while its column is hidden still marks it on re-show', async () => {
    const w = page();
    await w.__go(0);
    setBox(w, 'dob', false);                                // hide first
    const sel = w.document.getElementById('tabContactsSort');
    sel.value = 'contact_dob';
    sel.dispatchEvent(new w.Event('change', { bubbles: true }));  // latch fires, no mark paintable
    expect(headTexts(w).join(' ')).not.toMatch(/[↑↓⇅]/);
    setBox(w, 'dob', true);
    expect(headTexts(w).at(-1)).toBe('Date of Birth ↑');
  });

  test('a save that leaves nothing visible falls back to every default_on column', () => {
    // The dialog refuses zero checked boxes (listColsModal.r1); this is the
    // fallback behind it.
    const w = page();
    w.__save({ orderedKeys: ALL_KEYS, checkedKeys: ['retired_column'] });
    expect(headTexts(w)).toEqual(['ID', 'Name', 'Phone', 'Email', 'Address', 'Cases', 'Date of Birth']);
  });

  test('the screen follows the click even when storage throws', async () => {
    const w = page({ storageThrows: true });
    await w.__go(0);
    setBox(w, 'contact_phone', false);
    expect(headTexts(w)).toEqual(['ID', 'Name', 'Email', 'Address', 'Cases', 'Date of Birth']);
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 2)));
    expectAligned(w);
  });
});

describe('the stored choice', () => {
  test('hidden keys hide; unknown hidden keys drop; hiding everything falls back', () => {
    const w1 = page({ storedOff: 'contact_phone,retired_column' });
    expect(headTexts(w1)).toEqual(['ID', 'Name', 'Email', 'Address', 'Cases', 'Date of Birth']);
    const w2 = page({ storedOff: 'retired_column' });
    expect(w2.__vis().map((c) => c.key)).toEqual(ALL_KEYS);
    const w3 = page({ storedOff: ALL_KEYS.join(',') });      // hand-edited to hide all
    expect(headTexts(w3)).toEqual(['ID', 'Name', 'Phone', 'Email', 'Address', 'Cases', 'Date of Birth']);  // default_on fallback
  });

  test('a column a later slice ADDS is visible without touching the pref', () => {
    // Hidden-set storage is WHY: a saved choice lists what was turned off,
    // so a key the model gains later is simply not in it.
    const w = page({ storedOff: 'contact_phone' });
    w.__cols.push({ key: 'cf_new', label: 'New', default_on: true, render: () => '' });
    w.__apply();
    expect(w.__vis().some((c) => c.key === 'cf_new')).toBe(true);
    expect(headTexts(w)).toContain('New');
  });

  test('a stored cols_order reorders headers AND cells together; later-added columns append', () => {
    const w = page();
    const rev = [...ALL_KEYS].reverse();
    w.localStorage.setItem('yc.contacts.cols_order.6', rev.join(','));
    w.eval('contactsColsApply()');
    expect(w.__vis().map((c) => c.key)).toEqual(rev);
    expect(headTexts(w)).toEqual([...['ID', 'Name', 'Phone', 'Email', 'Address', 'Cases', 'Date of Birth']].reverse());
    // a column the stored order lacks (added later) appends at the end
    w.localStorage.setItem('yc.contacts.cols_order.6', 'dob,contact_id');
    w.__cols.push({ key: 'cf_new', label: 'New', default_on: true, render: () => '' });
    w.eval('contactsColsApply()');
    const h = headTexts(w);
    expect(h.slice(0, 2)).toEqual(['Date of Birth', 'ID']);
    expect(h.at(-1)).toBe('New');
  });

  test("the modal's Apply with a REORDERED answer repaints headers and cells in that order", async () => {
    const w = page();
    await w.__go(0);
    const rev = [...ALL_KEYS].reverse();
    w.__save({ orderedKeys: rev, checkedKeys: [...ALL_KEYS] });
    expect(headTexts(w)).toEqual([...['ID', 'Name', 'Phone', 'Email', 'Address', 'Cases', 'Date of Birth']].reverse());
    expect(cells(w)[0]).toEqual([...FROZEN.cells[0]].reverse());
    expect(w.localStorage.getItem('yc.contacts.cols_order.6')).toBe(rev.join(','));
    expectAligned(w);
  });

  test("another window's cols_order save re-applies through the storage listener", async () => {
    const w = page();
    await w.__go(0);
    const rev = [...ALL_KEYS].reverse();
    w.localStorage.setItem('yc.contacts.cols_order.6', rev.join(','));
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.contacts.cols_order.6' }));
    expect(headTexts(w)).toEqual([...['ID', 'Name', 'Phone', 'Email', 'Address', 'Cases', 'Date of Birth']].reverse());
    expectAligned(w);
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
    w.eval('window.__fail = true');
    await w.__go(0);                                        // error
    expect(w.__footOpts).toHaveLength(3);
    for (const o of w.__footOpts) expect(typeof o.onColumns).toBe('function');
  });

  test('the key carries the user id', () => {
    const w = page({ userId: 22, storedOff: hideAllBut('contact_id') });
    expect(headTexts(w)).toEqual(['ID']);
    const other = page({ userId: 22 });
    other.localStorage.setItem('yc.contacts.cols_off.6', hideAllBut('contact_id'));  // another user's pref
    other.eval('contactsColsApply()');
    expect(other.__vis().map((c) => c.key)).toEqual(ALL_KEYS);
  });

  test("another window's save re-applies here (the shipped storage listener)", async () => {
    // Evaluate the WHOLE contacts <script> block, then contactsColsInit,
    // so the listener the init registers is the thing under test.
    const declAt = INDEX.indexOf('const CONTACT_COLUMNS');
    const blockStart = INDEX.lastIndexOf('<script>', declAt) + '<script>'.length;
    const block = INDEX.slice(blockStart, INDEX.indexOf('</script>', declAt));
    const tableAt = INDEX.indexOf('<table id="contactsTable"');
    const tableMarkup = INDEX.slice(tableAt, INDEX.indexOf('</table>', tableAt) + '</table>'.length);
    const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabContacts" class="tab-main">${tableMarkup}
      <select id="tabContactsSort" data-type="sortBy"><option value="contact_lname">L</option></select>
      <select id="tabContactsSort2" data-type="sortDi"><option value="ASC">A</option></select>
      </div></body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    const w = jsd.window;
    Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
      get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
    });
    w.eval(`
      window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
      window.YC = { on: () => {} };
      ${SCRIPTS}
      var user = { user: 6 }, offsets = {}, contacts = null;
      var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
      var exportListCsv = () => {}, csvFilterOf = (p) => p;
      var apiSend = async () => ({ total: 0, contacts: [] });
      ${block}
      contactsColsInit();
    `);
    expect([...w.document.querySelectorAll('#contactsTable th')]).toHaveLength(7);
    w.contacts = FROZEN.rows.slice(0, 1);                   // a page on screen
    w.eval('contactsRenderRows()');
    w.localStorage.setItem('yc.contacts.cols_off.6', 'contact_phone');   // "another window" saved
    w.dispatchEvent(new w.StorageEvent('storage', { key: 'yc.contacts.cols_off.6' }));
    expect([...w.document.querySelectorAll('#contactsTable th')].map((t) => t.textContent.trim()))
      .toEqual(['ID', 'Name', 'Email', 'Address', 'Cases', 'Date of Birth']);
    // the rows follow in the same apply — never headers alone
    const row = w.document.querySelectorAll('#contactsTable tr')[1];
    expect(row.cells).toHaveLength(6);
    expect(row.cells[2].innerHTML).toBe(FROZEN.cells[0][3]);  // email where phone was
  });
});

describe('failure paths stay aligned', () => {
  test('a failed fetch nulls the cache — a picker change cannot redraw the stale page', async () => {
    const w = page();
    await w.__go(0);                                        // one good page
    w.__fail = true;
    await w.__go(0);                                        // cleared rows, failed fetch
    expect(cells(w)).toEqual([]);
    const foot = w.document.getElementById('contactsTableFoot').textContent;
    setBox(w, 'contact_phone', false);
    expect(cells(w)).toEqual([]);                           // no stale redraw
    expect(w.document.getElementById('contactsTableFoot').textContent).toBe(foot);
    expectAligned(w);
  });

  test('a picker change during an in-flight fetch cannot outlive its failure', async () => {
    // Same race, Contacts flavor (S3a review nit, fixed on both tabs): rows
    // a picker click painted from the cache while a fetch hung must not
    // survive that fetch's failure.
    const w = page();
    await w.__go(0);
    let reject;
    w.__hang = new Promise((res, rej) => { reject = rej; });
    w.eval('apiSend = () => window.__hang');
    const pending = w.__go(0);
    setBox(w, 'contact_phone', false);
    expect(cells(w)).toHaveLength(FROZEN.rows.length);      // stale rows ARE back
    reject(new Error('down'));
    await pending;
    expect(cells(w)).toEqual([]);                           // and the catch cleared them
    expectAligned(w);
  });

  test('an EMPTY fetch replaces the cache — a picker toggle cannot resurrect the page (S3b fix)', async () => {
    const w = page();
    await w.__go(0);
    w.__rows = [];
    await w.__go(0);                                        // the empty result
    expect(cells(w)).toEqual([]);
    setBox(w, 'contact_phone', false);
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
    setBox(w, 'contact_phone', false);                      // race: redraws the old page
    expect(cells(w)).toHaveLength(FROZEN.rows.length);
    resolve({ total: 0, contacts: [] });
    await pending;
    expect(cells(w)).toEqual([]);                           // the empty branch cleared them
    expectAligned(w);
  });

  test('a reset cache ("" after logout) cannot leave rows under rebuilt headers (S3b fix)', async () => {
    const w = page();
    await w.__go(0);                                        // rows on screen
    w.eval('contacts = ""');                                // the logout reset shape
    setBox(w, 'contact_phone', false);
    expect(cells(w)).toEqual([]);                           // cleared, not skipped
    expectAligned(w);
  });

  test('a picker change mid-page re-renders the page in memory and leaves the footer', async () => {
    const w = page();
    await w.__go(100);                                      // some offset
    const foot = w.document.getElementById('contactsTableFoot').textContent;
    expect(foot).toBe('pager');
    setBox(w, 'cases', false);
    expect(cells(w)).toEqual(FROZEN.cells.map((r) => r.filter((_, i) => i !== 5)));
    expect(w.document.getElementById('contactsTableFoot').textContent).toBe(foot);
    expectAligned(w);
  });
});

describe('the picker left the filter bar (R1)', () => {
  test('shipped markup: no Columns dropdown in the bar; the counter still counts a real filter', () => {
    const tabAt = INDEX.indexOf('<div id="tabContacts"');
    const bar = INDEX.slice(INDEX.indexOf('<div class="yc-filters">', tabAt),
      INDEX.indexOf('<table id="contactsTable"', tabAt));
    // The dropdown and its menu are gone — the modal (footer button) is the
    // only picker now.
    expect(bar).not.toContain('tabContactsColsMenu');
    expect(bar).not.toContain('id="tabContactsCols"');
    const jsd = new JSDOM(`<!DOCTYPE html><body><div id="tabContacts">${bar}
      <table id="contactsTable"><tr></tr></table></div></body>`,
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    const w = jsd.window;
    w.eval(`
      window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
      ${SCRIPTS}
      window.__active = (sel) => ycFiltersActive(document.querySelector(sel));
    `);
    expect(w.__active('.yc-filters')).toBe(0);
    const role = w.document.querySelector('#tabContactsRoleMenu input');
    role.checked = true;
    expect(w.__active('.yc-filters')).toBe(1);               // a real filter still does
  });
});

describe('boot wiring', () => {
  test('loadUserContext calls contactsColsInit as a live statement', () => {
    const init = fnSrc(INDEX, 'loadUserContext');
    expect(init).toMatch(/^\s*contactsColsInit\(\);$/m);     // not commented out
  });
});
