// tests/logCommDate.sort.test.js
//
/**
 * log-comm-date — the Date/Time header of every log table (index.html Logs,
 * case.html and contact.html Log tabs) flips newest-first <-> oldest-first.
 *
 * Each page runs as REAL code: the whole of public/scripts.js plus the page's
 * own getLogFilterParams (fnSrc pattern of tests/wsurlS0cRowRenders.test.js),
 * under the page's SHIPPED log-table markup. The toggle is dispatched on the
 * rendered header button, never called directly — an inline handler resolves
 * names against the element and document before window (CLAUDE.md), and a
 * direct call cannot see that. tabLogGet is the only stub: it records the
 * params the reload would send, which is also what the CSV export reads.
 *
 * Run:  npx jest tests/logCommDate.sort.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SCRIPTS = read('public/scripts.js');

function fnSrc(src, name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let j = src.indexOf('{', m.index); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(m.index, j + 1);
  }
  throw new Error(`function ${name}: unbalanced`);
}

function tableSrc(src) {
  const m = /<table id="logTable"[\s\S]*?<\/table>/.exec(src);
  if (!m) throw new Error('logTable not found');
  return m[0];
}

const SWAL_STUB = `
  window.Swal = {
    mixin: () => ({ fire: () => Promise.resolve({}) }),
    fire: () => Promise.resolve({ isConfirmed: false }),
    close() {}, showLoading() {}, update() {},
  };`;

function boot(file, scope) {
  const src = read(file);
  const jsd = new JSDOM(`<!DOCTYPE html><html><body>
      <input id="tabLogQuery" value="">
      <select id="tabLogType"><option>All</option></select>
      <select id="tabLogTime"><option>All</option></select>
      <input id="tabLogDate1" value=""><input id="tabLogDate2" value="">
      <select id="tabLogBy"><option value="">All</option></select>
      <select id="logDirectionFilter"><option value="">Any</option></select>
      ${tableSrc(src)}
    </body></html>`, { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  w.__loads = [];
  w.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + scope + '\n'
    + fnSrc(src, 'getLogFilterParams') + '\n'
    + 'function tabLogGet(offset) { window.__loads.push({ offset, params: getLogFilterParams() }); }');
  return w;
}

const PAGES = [
  ['public/index.html', '', {}],
  ['public/case.html', 'var caseID = "C9";', { link_type: 'case', link_id: 'C9' }],
  ['public/contact.html', 'var clientID = 2111;', { link_type: 'contact', link_id: 2111 }],
];

describe.each(PAGES)('%s', (file, scope, base) => {
  test('the Date/Time header flips the order, reloads from page 1, and the params carry it', () => {
    const w = boot(file, scope);
    const d = w.document;
    const btn = d.querySelector('#logTable th button.log-sort');
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain('Date/Time');

    // newest first by default: no sort param (the server default)
    expect(w.eval('getLogFilterParams()')).toEqual(base);

    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(w.__loads).toEqual([{ offset: 0, params: { ...base, sort: 'asc' } }]);
    expect(btn.querySelector('i').className).toBe('fa-solid fa-sort-up');
    expect(btn.title).toMatch(/^Oldest first/);

    btn.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(w.__loads[1]).toEqual({ offset: 0, params: base });
    expect(btn.querySelector('i').className).toBe('fa-solid fa-sort-down');
    expect(btn.title).toMatch(/^Newest first/);
    w.close();
  });
});
