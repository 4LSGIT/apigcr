/**
 * tests/contactColumns.s1.test.js
 *
 * The S1 refactor's zero-visible-change gate: the Contacts tab now renders
 * headers and rows from CONTACT_COLUMNS (the first column model) through
 * ycColsHeadRender / ycColsRowHtml, and this suite pins the output to what
 * the OLD positional template produced:
 *   1. cells — byte-for-byte against tests/fixtures/contactColumns.s1.json,
 *      captured from the landed renderer @ d325e7e over plain, sparse and
 *      hostile rows (cases as array AND as JSON string);
 *   2. headers — byte-for-byte against the static <th> row S1 removed,
 *      inline sort() onclicks included (sort()/sortSelect() select on them);
 *   3. nothing hostile executes or lands in the DOM;
 *   4. the model's own shape (unique keys, labels, default_on everywhere).
 * Real code throughout: scripts.js and the index.html functions in jsdom.
 *
 *   npx jest tests/contactColumns.s1.test.js
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

// The exact header row the static markup carried before S1.
const OLD_HEADER = [
  `<th onclick="sort(this, 'contact_id')">ID</th>`,
  `<th onclick="sort(this, 'contact_lname')">Name</th>`,
  '<th>Phone</th>',
  '<th>Email</th>',
  '<th>Address</th>',
  '<th>Cases</th>',
  `<th onclick="sort(this, 'contact_dob')">Date of Birth</th>`,
];

function page(rows) {
  const jsd = new JSDOM(`<!DOCTYPE html><body>
    <input id="tabContactsQuery"><div id="tabContactsLoad"></div>
    <div id="tabContactsRole"></div>
    <input id="tabContactsSort" value="contact_lname"><input id="tabContactsSort2" value="ASC">
    <table id="contactsTable"><tr></tr></table><div id="contactsTableFoot"></div>
  </body>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  w.__rows = rows;
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
    ${SCRIPTS}
    var offsets = {}, contacts;
    var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
    var exportListCsv = () => {}, csvFilterOf = (p) => p;
    var apiSend = async () => ({ total: window.__rows.length, contacts: window.__rows });
    ${constSrc(INDEX, 'CONTACT_COLUMNS')}
    ${fnSrc(INDEX, 'contactsRoleValues')}
    ${fnSrc(INDEX, 'tabContactsGet')}
    ycColsHeadRender(E('contactsTable'), CONTACT_COLUMNS);   // the parse-time build
    window.__go = tabContactsGet;
    window.__cols = CONTACT_COLUMNS;
    window.__headRender = ycColsHeadRender;
  `);
  return w;
}

describe('CONTACT_COLUMNS renders what the old template rendered', () => {
  test('every cell, byte for byte, against the frozen pre-S1 fixture', async () => {
    const w = page(FROZEN.rows);
    await w.__go(0);
    const got = [...w.document.querySelectorAll('#contactsTable tr')].slice(1)
      .map((tr) => [...tr.cells].map((td) => td.innerHTML));
    expect(got).toEqual(FROZEN.cells);
    expect(FROZEN.cells.length).toBe(4);               // the fixture itself
    expect(FROZEN.cells.every((r) => r.length === 7)).toBe(true);
  });

  test('the generated header row equals the static row S1 removed', () => {
    const w = page([]);                                 // parse-time build ran in page()
    const ths = () => [...w.document.querySelectorAll('#contactsTable th')].map((th) => th.outerHTML);
    expect(ths()).toEqual(OLD_HEADER);
    w.document.getElementById('contactsTable').deleteRow(0);
    w.__headRender(w.document.getElementById('contactsTable'), w.__cols);  // empty-table path
    expect(ths()).toEqual(OLD_HEADER);
  });

  test('a fetch never rebuilds the header row — sort marks survive it', async () => {
    const w = page(FROZEN.rows);
    // sort()/sortSelect() paint marks into the <th>s; pre-S1 the static
    // header persisted across fetches. Pin that: a mark planted in a header
    // must survive tabContactsGet, and the row count must stay one header +
    // the data rows.
    const th = w.document.querySelector('#contactsTable th');
    th.textContent += ' ▲';
    await w.__go(0);
    expect(w.document.querySelector('#contactsTable th').textContent).toContain('▲');
    expect(w.document.querySelectorAll('#contactsTable tr')).toHaveLength(1 + FROZEN.rows.length);
  });

  // Evaluate the WHOLE contacts <script> block, as shipped, against the real
  // table markup. This is the real gate for the top-level build call: a
  // commented-out call, one wrapped in a function nobody runs, or one moved
  // above the table (E() null) all fail it — a source-string pin would pass
  // them all.
  function evalContactsBlock(ycStub) {
    const declAt = INDEX.indexOf('const CONTACT_COLUMNS');
    const blockStart = INDEX.lastIndexOf('<script>', declAt) + '<script>'.length;
    const block = INDEX.slice(blockStart, INDEX.indexOf('</script>', declAt));
    const tableAt = INDEX.indexOf('<table id="contactsTable"');
    const tableMarkup = INDEX.slice(tableAt, INDEX.indexOf('</table>', tableAt) + '</table>'.length);
    const jsd = new JSDOM(`<!DOCTYPE html><body>${tableMarkup}</body>`,
      { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
    let threw = null;
    try {
      jsd.window.eval(`
        window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };
        window.YC = { on: ${ycStub} };    // the block registers sync-bus handlers
        ${SCRIPTS}
        ${block}
      `);
    } catch (e) { threw = e; }
    const ths = [...jsd.window.document.querySelectorAll('#contactsTable th')].map((th) => th.outerHTML);
    return { ths, threw };
  }

  test('the contacts script block itself builds the headers at parse time', () => {
    const { ths, threw } = evalContactsBlock('() => {}');
    expect(threw).toBeNull();
    expect(ths).toEqual(OLD_HEADER);
  });

  test('a sync-bus registration failure cannot leave the tab headerless', () => {
    // The build call sits ABOVE the block's YC.on registrations on purpose:
    // a yc-sync regression must not also strip the tab's headers. The block
    // still throws (liveness IS broken), but the headers are already there.
    const { ths, threw } = evalContactsBlock("() => { throw new Error('sync regression'); }");
    expect(threw).not.toBeNull();
    expect(ths).toEqual(OLD_HEADER);
  });

  test('the driver itself: a render-less column shows escText(row[key]), blank when absent', () => {
    const w = page([]);
    const html = w.eval(`ycColsRowHtml(
      [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
      { a: '<b>&"x"</b>' })`);
    expect(html).toBe(`<td>${w.eval(`escText('<b>&"x"</b>')`)}</td><td></td>`);
    expect(html).not.toContain('<b>');
  });

  test('nothing hostile executes or lands in the DOM', async () => {
    const w = page(FROZEN.rows);
    await w.__go(0);
    const d = w.document;
    expect(d.getElementById('pwn')).toBeNull();
    expect(d.querySelectorAll('img')).toHaveLength(0);
    expect(d.querySelectorAll('[onmouseover]')).toHaveLength(0);
  });

  test('the model is well-formed: unique keys, labels, default_on on every column', () => {
    const w = page([]);
    const cols = w.__cols;
    expect(cols).toHaveLength(7);
    expect(new Set(cols.map((c) => c.key)).size).toBe(7);
    for (const c of cols) {
      expect(typeof c.key).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(c.default_on).toBe(true);
      // sort and label are interpolated into header markup, so the contract
      // (scripts.js) demands static code literals; pin sort's safe shape.
      if (c.sort != null) expect(c.sort).toMatch(/^[a-z_.]+$/);
    }
  });
});
