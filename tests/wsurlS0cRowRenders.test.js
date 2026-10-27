/**
 * wsurl S0c — the row renders S0b touched escape EVERY data field.
 *
 * S0b made the file-open links safe; the cells around them were still raw
 * innerHTML (case_number, statuses, names, emails, addresses, dates as the
 * server formats them), and a few rows quoted server text into onclick
 * source: the shell's Appts action buttons (status, dates), the Log's
 * orphan-adopt links (raw phone / email / docket), case.html's clients-table
 * Modify button (relate type).
 *
 * Each lane function runs here as REAL code: the whole of public/scripts.js
 * plus the function (and the helpers and constants it calls) extracted from
 * the shipped HTML with the fnSrc pattern of tests/unifiedEventsU9.shell.test.js.
 * Only collaborators are stubbed: apiSend, the pager, the dialogs the
 * buttons open.
 *
 * Every string field of the row gets the same value V, run three ways:
 *   HOSTILE  markup, an attribute breakout and a JS-string breakout at once
 *            → no element or attribute injected, the text shows literally,
 *            and the bound actions receive the raw value;
 *   ORDINARY "O'Brien & Sons" → the same text the page showed before;
 *   ENTITY   "&amp;" (already-escaped looking data) → shows "&amp;", once.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const INDEX = read('public/index.html');
const CASE = read('public/case.html');
const CONTACT = read('public/contact.html');

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

/** `const NAME = {…};` / `[…];` from the page source. */
function constSrc(src, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src);
  if (!m) throw new Error(`const ${name} not found`);
  const open = m.index + m[0].length;
  const pairs = { '{': '}', '[': ']' };
  const close = pairs[src[open]];
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === src[open]) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(m.index, j + 1) + ';';
  }
  throw new Error(`const ${name}: unbalanced`);
}

const HOSTILE = '<img id=pwn src=x>"onmouseover=alert(1) \\\';x//';
const ORDINARY = "O'Brien & Sons";
const ENTITY = '&amp;';
const VALUES = [['HOSTILE', HOSTILE], ['ORDINARY', ORDINARY], ['ENTITY', ENTITY]];

const SWAL_STUB = `
  window.Swal = {
    mixin: () => ({ fire: () => Promise.resolve({}) }),
    fire: () => Promise.resolve({ isConfirmed: false }),
    close() {}, showLoading() {}, update() {},
  };`;

/**
 * A window running the real scripts.js plus `code`. `dom` maps element ids
 * to 'table' | 'div' | 'check' | 'input=<value>' | 'select=<value>'.
 */
function page(dom, code, api) {
  const jsd = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  const d = w.document;
  for (const [id, kind] of Object.entries(dom)) {
    const [k, v = ''] = kind.split('=');
    let el;
    if (k === 'table') { el = d.createElement('table'); el.innerHTML = '<tr><th>h</th></tr>'; }
    else if (k === 'div') el = d.createElement('div');
    else if (k === 'check') { el = d.createElement('input'); el.type = 'checkbox'; }
    else if (k === 'select') { el = d.createElement('select'); el.innerHTML = `<option value="${v}">x</option>`; }
    else { el = d.createElement('input'); el.value = v; }
    el.id = id;
    d.body.appendChild(el);
  }
  w.apiSend = api;            // the shell's transport; P.apiSend in a pane (P === window here)
  w.__calls = { addFile: [] };
  w.addFile = (...a) => w.__calls.addFile.push(a);
  // One eval: separate <script> tags share one global lexical environment.
  // Stub declarations come AFTER scripts.js, so they win where both declare.
  w.eval(SWAL_STUB + '\n' + SCRIPTS + '\n' + code);
  return w;
}

const spy = (w, name) => { w.__calls[name] = []; w[name] = (...a) => w.__calls[name].push(a); };
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
const dataRow = (w, tableId) => w.document.querySelectorAll(`#${tableId} tr`)[1];
const cellText = (row) => [...row.cells].map((c) => c.textContent.trim());

/** Nothing injected: no element the data could have made, no on* handler
 *  attribute the static markup doesn't carry. */
function expectClean(w) {
  const d = w.document;
  expect(d.getElementById('pwn')).toBeNull();
  expect(d.querySelectorAll('img')).toHaveLength(0);
  expect(d.querySelectorAll('[onmouseover]')).toHaveLength(0);
}

const PAGER = 'var YcPager = { getLimit: (k, d) => d, renderFooter() {} };';

// ─────────────────────────────────────────────────────────────────────────────
describe.each(VALUES)('wsurl S0c — index.html, data = %s', (_, V) => {
  test('tabCasesGet', async () => {
    const w = page({
      tabCasesLoad: 'div', tabCasesQuery: 'input', tabCasesType: 'select=%', tabCasesStage: 'input=%',
      tabCasesStatus: 'input', tabCasesOrder: 'input', tabCasesOrder2: 'input',
      casesTable: 'table', casesTableFoot: 'div',
    }, `${PAGER} var offsets = {}, cases; function populateCaseTypeFilter() {}
        ${fnSrc(INDEX, 'tabCasesGet')}`,
    async () => ({ total: 1, cases: [{
      case_id: 'ABCD2345', case_number: V, case_type: V, case_subtype: V, case_stage: V,
      case_status: V, open: V, file: V, close: V,
      contacts: [{ contact_id: 1405, contact_name: V, contact_relate: V }],
    }] }));
    await w.tabCasesGet(0);
    expectClean(w);
    expect(cellText(dataRow(w, 'casesTable'))).toEqual(
      ['ABCD2345', `${V} (${V})`, V, `${V}: ${V}`, V, V, V, V, V]);
  });

  test('tabContactsGet', async () => {
    const w = page({
      tabContactsLoad: 'div', tabContactsQuery: 'input', tabContactsSort: 'input=contact_lname', tabContactsSort2: 'input=ASC',
      tabContactsRole: 'input', contactsTable: 'table', contactsTableFoot: 'div',
    }, `${PAGER} var offsets = {}, contacts; ${fnSrc(INDEX, 'tabContactsGet')}`,
    async () => ({ total: 1, contacts: [{
      contact_id: 1405, contact_name: V, contact_phone: V, contact_email: V, contact_address: V,
      contact_city: V, contact_state: V, contact_zip: V, dob: V,
      cases: [{ case_id: 'ABCD2345', case_number: V }],
    }] }));
    await w.tabContactsGet(0);
    expectClean(w);
    expect(cellText(dataRow(w, 'contactsTable'))).toEqual(
      ['1405', V, V, V, `${V}${V}, ${V} ${V}`, V, V]);
  });

  test('calxGet', async () => {
    const w = page({
      calxButton: 'input', calxLoad: 'div', calxFrom: 'input=2026-10-01', calxTo: 'input=2026-10-31',
      calxState: 'input=all', calxSuperseded: 'check', calxWith: 'select=', calxTable: 'table',
      calxFoot: 'div', calxKinds: 'div', calxSortBy: 'input=upcoming', calxSortDir: 'input=ASC',
    }, `var calxSeq = 0, calxRows = null;
        ${['CALX_MONTHS', 'CALX_DAYS', 'CALX_KIND_ICON', 'CALX_RESOLUTION_LABEL', 'CALX_APPT_STATUS', 'CALX_SORT_KEYS']
          .map((c) => constSrc(INDEX, c)).join('\n')}
        ${['calxEsc', 'calxISO', 'calxSortRows', 'calxWhen', 'calxBadge', 'calxAnchor', 'calxWithName', 'calxApptStatus',
          'calxActions', 'calxAct', 'calxSelectedKinds', 'calxFilterSentence', 'calxGet']
          .map((f) => fnSrc(INDEX, f)).join('\n')}`,
    async () => ({ has_more: true, limit: V, items: [{
      source: 'event', source_id: 9, kind_key: V, title: V, type_key: V,
      starts_at: '2026-10-15 09:30:00', link_type: 'contact', link_id: 1405,
      display: { contact_name: V }, attendees: [{ party: 'user', id: 6 }],
      state: 'resolved', resolution: V,
    }] }));
    w.firmData = { users: [{ user: 6, user_name: V }] };
    await w.calxGet();
    expectClean(w);
    const cells = cellText(dataRow(w, 'calxTable'));
    expect(cells.slice(1, 6)).toEqual([V, `${V} ${V}`, V, V, V]);
    expect(w.document.getElementById('calxFoot').textContent).toContain(`capped at ${V} —`);
  });

  test('tabEventsGet', async () => {
    const w = page({
      tabEventsButton: 'input', tabEventsLoad: 'div', tabEventsType: 'input', tabEventsStatus: 'input',
      tabEventsTime: 'input', tabEventsDate1: 'input', tabEventsDate2: 'input', tabEventsQ: 'input',
      tabEventsSort: 'input', tabEventsSort2: 'input=ASC', tabEventsUnlinked: 'check', eventsTable: 'table', eventsTableFoot: 'div',
    }, `${PAGER} var offsets = {}, events;
        ${fnSrc(INDEX, 'escHtml')} ${fnSrc(INDEX, 'escAttrJSON')} ${fnSrc(INDEX, 'tabEventsGet')}`,
    async () => ({ total: 1, data: [{
      event_id: 9, event_type: V, event_title: V, event_date: V, event_time: V, event_all_day: 0,
      event_with: 6, event_status: V, event_link_type: 'contact', event_link_id: 1405,
      link_label: V, event_location: V,
    }] }));
    w.firmData = { users: [{ user: 6, user_name: V }] };
    await w.tabEventsGet(0);
    expectClean(w);
    expect(cellText(dataRow(w, 'eventsTable')).slice(0, 9)).toEqual(
      ['9', V, V, V.slice(0, 10).trim(), V.slice(0, 5).trim(), V, V, `Contact: ${V}`, V]);
  });

  test('tabApptsGet: cells, and the action buttons get the raw values', async () => {
    const w = page({
      tabApptsButton: 'input', tabApptsLoad: 'div', tabApptsType: 'input=__all__',
      tabApptsStatus: 'input=All', tabApptsTime: 'input', tabApptsDate1: 'input',
      tabApptsDate2: 'input', tabApptsWith: 'input', tabApptsSort: 'input=upcoming', tabApptsSort2: 'input=ASC',
      apptsTable: 'table', apptsTableFoot: 'div',
    }, `${PAGER} var offsets = {}, appts, apptsLastLoad = 0; function tabApptsTypesLoad() {}
        ${fnSrc(INDEX, 'tabApptsGet')}`,
    async () => ({ counter: 1, appts: [{
      id: 5, format_date: V, time: V, contact_name: V, appt_client_id: 1405, case_number: V,
      appt_case_id: 'ABCD2345', appt_type: V, status: V, user_name: V, appt_datetime_local: V,
    }] }));
    spy(w, 'apptUpdate');
    await w.tabApptsGet(0);
    expectClean(w);
    const row = dataRow(w, 'apptsTable');
    expect(cellText(row).slice(0, 8)).toEqual(['5', V, V, V, V, V, V, V]);
    const btns = row.querySelectorAll('button');
    expect(btns).toHaveLength(4);
    btns.forEach((b) => { expect(b.hasAttribute('onclick')).toBe(false); click(w, b); });
    expect(w.__calls.apptUpdate).toEqual([
      [5, 'Attended', null, null, V],
      [5, 'No Show', null, null, V],
      [5, 'Cancel', `${V} at ${V}`, null, V],
      [5, 'Reschedule', V, null, V],
    ]);
  });

  test('tabLogGet: cells, and the adopt links get the raw values', async () => {
    const w = page({ tabLogButton: 'input', tabLogLoad: 'div', logTable: 'table', logTableFoot: 'div' },
      `var offsets = {}, logs, limit = 100;
       function getLogFilterParams() { return {}; } function exportLog() {}
       ${fnSrc(INDEX, 'tabLogGet')}`,
      async () => {
        const base = { log_type: V, formatted_date: V, log_data: V, by_name: V };
        return { total: 4, entries: [
          { ...base, log_id: 1, log_link_type: 'phone', log_link_id: V },
          { ...base, log_id: 2, log_link_type: 'email', log_link_id: V },
          { ...base, log_id: 3, log_link_type: 'case', log_link_id: V },
          { ...base, log_id: 4, log_link_type: null, log_link: V },
        ] };
      });
    spy(w, 'OrphanAdoptDialog');
    spy(w, 'CaseAdoptDialog');
    await w.tabLogGet(0);
    expectClean(w);
    const rows = [...w.document.querySelectorAll('#logTable tr')].slice(1);
    expect(rows).toHaveLength(4);
    rows.forEach((r) => {
      const c = cellText(r);
      expect([c[1], c[2], c[4], c[5]]).toEqual([V, V, V, V]);
      expect(c[3]).toContain(V);
    });
    const adopt = w.document.querySelectorAll('#logTable a[data-adopt]');
    expect(adopt).toHaveLength(3);
    adopt.forEach((a) => { expect(a.hasAttribute('onclick')).toBe(false); click(w, a); });
    expect(w.__calls.OrphanAdoptDialog.map((a) => a.slice(0, 2))).toEqual([[V, 'phone'], [V, 'email']]);
    expect(w.__calls.CaseAdoptDialog.map((a) => a[0])).toEqual([V]);
    for (const a of [...w.__calls.OrphanAdoptDialog, ...w.__calls.CaseAdoptDialog]) {
      expect(typeof a[a.length - 1]).toBe('function');   // the refresh callback
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
async function entityLog(SRC, V) {
  const w = page({ tabLogButton: 'input', tabLogLoad: 'div', logTable: 'table', logTableFoot: 'div' },
    `var limit = 100, logs = [];
     function getLogFilterParams() { return {}; } function exportLog() {}
     ${fnSrc(SRC, 'tabLogGet')}`,
    async () => {
      const base = { log_type: V, formatted_date: V, log_data: V, by_name: V };
      return { total: 2, entries: [
        { ...base, log_id: 1, case_id: 'ABCD2345', log_link: 'ABCD2345', case_number: V },
        { ...base, log_id: 2, contact_id: 1405, log_link: '1405', contact_name: V },
      ] };
    });
  await w.tabLogGet(0);
  return w;
}

describe.each(VALUES)('wsurl S0c — case.html / contact.html, data = %s', (_, V) => {
  test.each([['case.html', CASE], ['contact.html', CONTACT]])('%s tabLogGet', async (__, SRC) => {
    const w = await entityLog(SRC, V);
    expectClean(w);
    const rows = [...w.document.querySelectorAll('#logTable tr')].slice(1);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      const c = cellText(r);
      expect([c[1], c[2], c[3], c[4], c[5]]).toEqual([V, V, V, V, V]);
    });
  });

  test('case.html putClients: cells, and Modify gets the raw values', () => {
    const w = page({ clientsTable: 'table' }, fnSrc(CASE, 'putClients'), async () => ({}));
    w.entityData = { clients: [{
      contact_id: 1405, contact_name: V, contact_phone: V, contact_email: V, contact_address: V,
      contact_city: V, contact_state: V, contact_zip: V, dob: V, contact_ssn: V, relate_type: V,
    }] };
    spy(w, 'modifyCaseClient');
    w.putClients();
    expectClean(w);
    const row = dataRow(w, 'clientsTable');
    expect(cellText(row).slice(0, 11)).toEqual(['1405', V, V, V, V, V, V, V, V, V, V]);
    const btn = row.querySelector('button');
    expect(btn.hasAttribute('onclick')).toBe(false);
    click(w, btn);
    expect(w.__calls.modifyCaseClient).toEqual([['1405', V]]);
  });

  test('contact.html putCases', () => {
    const w = page({ casesHeader: 'div', casesTable: 'table' }, fnSrc(CONTACT, 'putCases'), async () => ({}));
    w.entityData = { cases: [{
      case_id: 'ABCD2345', relate_type: V, case_number_full: V, case_type: V, case_subtype: V,
      case_stage: V, case_status: V, open: V, file: V, close: V,
    }] };
    w.putCases();
    expectClean(w);
    expect(cellText(dataRow(w, 'casesTable'))).toEqual(
      ['ABCD2345', V, V, `${V}: ${V}`, V, V, V, V, V]);
  });
});
