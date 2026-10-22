// tests/logCommDate.marker.test.js
//
/**
 * log-comm-date — a backdated log row says so. A row whose time staff set by
 * hand carries log_extra.logged_at (POST /api/log `date`); its Date/Time cell
 * gets a second, muted "entered …" line in firm time, and the CSV export an
 * "Entered (if backdated)" column. Every other row renders as before.
 *
 * Each page's REAL tabLogGet row template runs (index.html Logs, case.html and
 * contact.html Log tabs) over the whole of public/scripts.js — the
 * tests/wsurlS0cRowRenders.test.js harness shape. The firm zone is Los Angeles
 * on purpose: this machine is in Detroit, so a marker formatted in the
 * browser's zone would show a different hour and fail.
 *
 * Run:  npx jest tests/logCommDate.marker.test.js
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

const SWAL_STUB = `
  window.Swal = {
    mixin: () => ({ fire: () => Promise.resolve({}) }),
    fire: () => Promise.resolve({ isConfirmed: false }),
    close() {}, showLoading() {}, update() {},
  };`;
const PAGER = 'var YcPager = { getLimit: (k, d) => d, renderFooter() {} };';

// 14:05Z on Oct 12 = 7:05 AM in Los Angeles (PDT), 10:05 AM in Detroit.
const LOGGED_AT = '2026-10-12T14:05:00.000Z';
const ENTRIES = [
  { log_id: 1, log_type: 'call', formatted_date: 'October 8, 2026 at 11:30 PM', log_data: '{}', by_name: 'Stuart',
    log_link_type: 'contact', log_link_id: '2111', log_link: '2111', contact_id: 2111, contact_name: 'Ryan',
    log_extra: { logged_at: LOGGED_AT } },
  { log_id: 2, log_type: 'call', formatted_date: 'October 9, 2026 at 09:00 AM', log_data: '{}', by_name: 'Stuart',
    log_link_type: 'contact', log_link_id: '2111', log_link: '2111', contact_id: 2111, contact_name: 'Ryan',
    log_extra: { provider: 'ringcentral' } },
  // the string form a non-mysql2 caller could hand over
  { log_id: 3, log_type: 'note', formatted_date: 'October 10, 2026 at 08:00 AM', log_data: 'x', by_name: 'Stuart',
    log_link_type: 'contact', log_link_id: '2111', log_link: '2111', contact_id: 2111, contact_name: 'Ryan',
    log_extra: JSON.stringify({ logged_at: LOGGED_AT }) },
];

function page(src, scope) {
  const jsd = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  const d = w.document;
  for (const [id, tag] of [['tabLogButton', 'input'], ['tabLogLoad', 'div'], ['logTable', 'table'], ['logTableFoot', 'div']]) {
    const el = d.createElement(tag);
    if (tag === 'table') el.innerHTML = '<tr><th>h</th></tr>';
    el.id = id;
    d.body.appendChild(el);
  }
  w.apiSend = async () => ({ total: ENTRIES.length, entries: ENTRIES });
  w.firmData = { firmTimezone: 'America/Los_Angeles' };
  w.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + PAGER + '\n' + scope + `
    function getLogFilterParams() { return {}; } function exportLog() {}
    ${fnSrc(src, 'tabLogGet')}`);
  return w;
}

const PAGES = [
  ['index.html', read('public/index.html'), 'var offsets = {}, logs, limit = 100;'],
  ['case.html', read('public/case.html'), 'var limit = 100, logs = [], caseID = "C9";'],
  ['contact.html', read('public/contact.html'), 'var limit = 100, logs = [], clientID = 2111;'],
];

describe.each(PAGES)('%s log table', (_name, src, scope) => {
  test('a backdated row shows when it was really typed, in firm time; the others do not', async () => {
    const w = page(src, scope);
    await w.tabLogGet(0);
    const rows = [...w.document.querySelectorAll('#logTable tr')].slice(1);
    expect(rows).toHaveLength(3);
    const cell = (r) => r.cells[2];

    const marked = cell(rows[0]).querySelector('.log-entered');
    expect(marked).not.toBeNull();
    expect(marked.textContent).toBe('entered Oct 12, 2026, 7:05 AM');
    expect(cell(rows[0]).textContent).toBe('October 8, 2026 at 11:30 PMentered Oct 12, 2026, 7:05 AM');

    expect(cell(rows[1]).querySelector('.log-entered')).toBeNull();
    expect(cell(rows[1]).textContent).toBe('October 9, 2026 at 09:00 AM');

    expect(cell(rows[2]).querySelector('.log-entered').textContent).toBe('entered Oct 12, 2026, 7:05 AM');
    w.close();
  });
});

test('the CSV export carries an Entered column, firm-local, empty unless backdated', () => {
  const w = page(read('public/index.html'), 'var offsets = {}, logs, limit = 100;');
  // RFC 4180 fields: formatted_date holds commas, so it arrives quoted.
  const fields = (line) => [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
    .slice(0, -1).map((m) => m[1].replace(/^"|"$/g, '').replace(/""/g, '"'));
  const lines = w.buildLogCsv(ENTRIES).replace(/^﻿/, '').split('\r\n').map(fields);
  const header = lines[0];
  const col = header.indexOf('Entered (if backdated)');
  expect(col).toBe(header.indexOf('Date (ISO)') + 1);
  expect(lines[1]).toHaveLength(header.length);
  const at = (i) => lines[i][col];
  expect(at(1)).toBe('2026-10-12 07:05');
  expect(at(2)).toBe('');
  expect(at(3)).toBe('2026-10-12 07:05');
  w.close();
});
