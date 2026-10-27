/**
 * tests/listCsvExport.test.js
 *
 * The list exports: scripts.js exportListCsv (one probe → range dialog →
 * fetch → download flow for every paged list, LIST_CSV naming each list's
 * endpoint, response keys and columns) and exportRowsCsv (the Calendar
 * list's rows in hand), plus the Export buttons that call them — the shell's
 * Cases / Contacts / Appts / Events footers, the Calendar list footer, and
 * tasks.html's footer.
 *
 * Everything runs as REAL code: the whole of public/scripts.js and
 * public/js/csvSafe.js in jsdom, and the tab functions lifted out of the
 * shipped HTML (the fnSrc pattern of tests/wsurlS0cRowRenders.test.js).
 * Stubbed: the transport, Swal (the range dialog answers "all"), the pager
 * (captures the footer's opts so the Export button can be pressed), and
 * downloadFile (captures the file).
 *
 *   npx jest tests/listCsvExport.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SCRIPTS = read('public/scripts.js');
const CSVSAFE = read('public/js/csvSafe.js');
const INDEX = read('public/index.html');
const TASKS = read('public/tasks.html');

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

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));

/**
 * A window running csvSafe.js + scripts.js + `code`. The range dialog
 * answers "export all"; downloads land in w.__files; every footer's opts
 * land in w.__footers. `dom` as in wsurlS0cRowRenders: id → element kind.
 */
function page(api, code = '', dom = {}) {
  const jsd = new JSDOM('<!DOCTYPE html><html><body></body></html>',
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  DOMS.push(jsd);
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
  w.calls = [];
  // api(url, params, n): n = this call's index, so a stub can tell the probe
  // (call 0) from a one-row range (also limit 1).
  w.apiSend = async (url, method, params) => { w.calls.push({ url, method, params }); return api(url, params, w.calls.length - 1); };
  w.__files = [];
  w.__footers = [];
  w.__toasts = [];
  w.eval(`
    window.Swal = {
      mixin: () => ({ fire: (o) => { window.__toasts.push(o); return Promise.resolve({}); } }),
      // The range dialog: run its preConfirm with "all" checked.
      fire: (o) => Promise.resolve({ isConfirmed: true, value: window.__swalValue }),
      close() {}, showLoading() {}, update() {}, showValidationMessage() {},
    };
    ${CSVSAFE}
    ${SCRIPTS}
    function downloadFile(content, filename, mimeType) { window.__files.push({ content, filename, mimeType }); }
    // The eval's own lexical scope (its consts are invisible to a later eval).
    window.__lex = (name) => eval(name);
    var YcPager = { getLimit: (k, d) => d, renderFooter: (el, o) => window.__footers.push(o) };
    ${code}`);
  return w;
}

/** A captured CSV as rows of cells (BOM dropped; no quoted commas in these fixtures). */
const parse = (f) => f.content.replace(/^﻿/, '').split('\r\n').map((l) => l.split(','));
const settle = (w) => new Promise((r) => w.setTimeout(r, 0));

const HOSTILE = '=HYPERLINK("http://x")';
const NEUTRAL = `"'=HYPERLINK(""http://x"")"`;

// One row per list, a hostile value in one text column of each.
const LISTS = {
  cases: {
    endpoint: '/api/cases', rowsKey: 'cases', totalKey: 'total', prefix: 'yisracase-cases',
    header: ['Case ID', 'Case Number', 'Caption', 'Type', 'Subtype', 'Chapter', 'Stage', 'Status',
      'Judge', 'Trustee', 'Opened', 'Filed', 'Closed', 'Contacts'],
    row: { case_id: 'ABCD2345', case_number: '26-12345', case_caption: HOSTILE, case_type: 'bk',
      case_subtype: 'ch7', case_chapter: 7, case_stage: 'Open', case_status: 'Active',
      open: 'Oct. 1, 2026', file: '', close: '',
      // As mysql2 hands JSON_ARRAYAGG over the wire: JSON text.
      contacts: JSON.stringify([{ contact_id: 5, contact_name: 'Pat One', contact_relate: 'Primary' },
        { contact_id: 6, contact_name: 'Sam Two', contact_relate: null }]) },
    want: { 'Caption': NEUTRAL, 'Chapter': '7', 'Contacts': 'Pat One (Primary); Sam Two' },
  },
  contacts: {
    endpoint: '/api/contacts', rowsKey: 'contacts', totalKey: 'total', prefix: 'yisracase-contacts',
    header: ['Contact ID', 'Name', 'First', 'Middle', 'Last', 'Type', 'Phone', 'Email', 'Address',
      'City', 'State', 'Zip', 'DOB', 'Tags', 'Cases'],
    row: { contact_id: 1405, contact_name: HOSTILE, contact_fname: 'Pat', contact_lname: 'One',
      contact_phone: '3135551212', contact_email: 'p@x.com', contact_zip: '48201',
      cases: [{ case_id: 'ABCD2345', case_number: '26-12345' }, { case_id: null, case_number: null }] },
    want: { 'Name': NEUTRAL, 'Phone': '313-555-1212', 'Cases': '26-12345', 'Middle': '' },
  },
  appts: {
    endpoint: '/api/appts', rowsKey: 'appts', totalKey: 'counter', prefix: 'yisracase-appts',
    header: ['Appt ID', 'Date', 'Time', 'Client', 'Client ID', 'Case Number', 'Case ID', 'Type',
      'Length (min)', 'Platform', 'Status', 'With', 'Note'],
    row: { id: 5, format_date: 'Oct. 15, 2026', time: '09:30 AM', contact_name: 'Pat One',
      appt_client_id: 1405, appt_type: '341 Meeting', appt_note: HOSTILE, status: 'Scheduled' },
    want: { 'Note': NEUTRAL, 'Appt ID': '5', 'Status': 'Scheduled' },
  },
  events: {
    endpoint: '/api/events', rowsKey: 'data', totalKey: 'total', prefix: 'yisracase-events',
    header: ['Event ID', 'Type', 'Title', 'Date', 'Time', 'Length (min)', 'Blocks', 'Status',
      'Resolution', 'Linked Type', 'Linked To', 'Location', 'Note'],
    row: { event_id: 9, event_title: HOSTILE, event_date: '2026-10-15T00:00:00.000Z',
      event_time: '09:30:00', event_all_day: 0, event_with: 6, event_link_type: 'contact',
      link_label: 'Pat One' },
    want: { 'Title': NEUTRAL, 'Date': '2026-10-15', 'Time': '09:30', 'Blocks': 'Fred Ross',
      'Linked To': 'Pat One' },
  },
  tasks: {
    endpoint: '/api/tasks', rowsKey: 'data', totalKey: 'total', prefix: 'yisracase-tasks',
    header: ['Task ID', 'Status', 'Title', 'Description', 'Due', 'Start', 'Assigned To',
      'Assigned By', 'Linked Type', 'Linked To', 'Created', 'Source'],
    row: { id: 3, status: 'Pending', title: HOSTILE, desc: '', due: '2026-10-30T00:00:00.000Z',
      start: null, created: '2026-10-01T16:00:00.000Z', from: { id: 6, name: 'Fred Ross' },
      to: { id: 22, name: 'Rena G' }, link: { type: 'case', id: 'ABCD2345', title: '26-12345' } },
    want: { 'Title': NEUTRAL, 'Due': '2026-10-30', 'Start': '', 'Assigned To': 'Rena G',
      'Assigned By': 'Fred Ross', 'Linked Type': 'case', 'Linked To': '26-12345' },
  },
  log: {
    endpoint: '/api/log', rowsKey: 'entries', totalKey: 'total', prefix: 'yisracase-log',
    row: { log_id: 7, log_type: 'note', log_subject: HOSTILE },
    want: { 'Log ID': '7', 'Subject': NEUTRAL },
  },
};

const FIRM = { users: [{ user: 6, user_name: 'Fred Ross' }] };

/** The stub list API for one spec: the probe gets the total, the range gets the row. */
const listApi = (spec) => {
  let n = 0;
  return (url) => {
    if (url !== spec.endpoint) return {};
    return n++ === 0 ? { [spec.totalKey]: 2 } : { [spec.rowsKey]: [spec.row] };
  };
};

describe('exportListCsv: probe → fetch → one neutralised file, per list', () => {
  test.each(Object.keys(LISTS))('%s', async (kind) => {
    const spec = LISTS[kind];
    const w = page(listApi(spec));
    w.firmData = FIRM;
    w.__swalValue = { from: 1, to: 2 };
    await w.exportListCsv(kind, () => ({ q: 'pat' }));

    // The probe and the range, on the list's endpoint, under the given filters.
    expect(w.calls).toEqual([
      { url: spec.endpoint, method: 'GET', params: { q: 'pat', limit: 1, offset: 0 } },
      { url: spec.endpoint, method: 'GET', params: { q: 'pat', limit: 2, offset: 0 } },
    ]);
    expect(w.__files).toHaveLength(1);
    const f = w.__files[0];
    expect(f.filename).toMatch(new RegExp(`^${spec.prefix}-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
    expect(f.content.startsWith('﻿')).toBe(true);
    const [header, row] = f.content.replace(/^﻿/, '').split('\r\n');
    const labels = header.split(',');
    if (spec.header) expect(labels).toEqual(spec.header);
    // Cells by label. The hostile one is quoted as a whole, so split on the
    // known columns rather than on every comma.
    const cells = {};
    let rest = row;
    for (const l of labels) {
      const m = rest.match(/^("(?:[^"]|"")*"|[^,]*)(?:,|$)/);
      cells[l] = m[1];
      rest = rest.slice(m[0].length);
    }
    for (const [label, want] of Object.entries(spec.want)) {
      expect({ label, cell: cells[label] }).toEqual({ label, cell: want });
    }
  });

  test('an export filename prefix overrides the list default (case/contact log exports)', async () => {
    const w = page(listApi(LISTS.log));
    w.__swalValue = { from: 1, to: 2 };
    await w.exportLogCsv(() => ({}), 'case-ABCD2345-log');
    expect(w.__files[0].filename).toMatch(/^case-ABCD2345-log-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  test('a partial range names itself in the filename and fetches that slice', async () => {
    const w = page(listApi(LISTS.cases));
    w.__swalValue = { from: 2, to: 2 };
    await w.exportListCsv('cases', () => ({}));
    expect(w.calls[1].params).toEqual({ limit: 1, offset: 1 });
    expect(w.__files[0].filename).toMatch(/^yisracase-cases-2-2-/);
  });

  test('opts.send replaces the shell transport (tasks.html)', async () => {
    const w = page(() => ({}));
    const sent = [];
    const tasksApi = listApi(LISTS.tasks);
    const send = async (url) => { sent.push(url); return tasksApi(url); };
    w.__swalValue = { from: 1, to: 2 };
    await w.exportListCsv('tasks', () => ({}), { send });
    expect(sent).toEqual(['/api/tasks', '/api/tasks']);
    expect(w.calls).toEqual([]);
    expect(w.__files).toHaveLength(1);
  });

  test('zero matches: no dialog, no file', async () => {
    const w = page(() => ({ total: 0 }));
    await w.exportListCsv('contacts', () => ({}));
    expect(w.calls).toHaveLength(1);
    expect(w.__files).toEqual([]);
  });

  test('an unknown list throws rather than exporting something else', async () => {
    const w = page(() => ({}));
    await expect(w.exportListCsv('pipeline', () => ({}))).rejects.toThrow(/unknown list "pipeline"/);
  });

  test('event Time and Blocks follow the tab: all day, firm-wide, nobody', () => {
    const w = page(() => ({}));
    const cols = w.__lex('EVENT_CSV_COLUMNS');
    const csv = (r) => parse({ content: w.buildCsv(cols, [r]) })[1];
    const col = (n) => cols.findIndex((c) => c.label === n);
    expect(csv({ event_all_day: 1, event_with: 6 })[col('Time')]).toBe('All day');
    expect(csv({ event_all_day: 1, event_with: 6 })[col('Blocks')]).toBe('');
    expect(csv({ event_all_day: 0, event_with: null })[col('Blocks')]).toBe('Everyone');
    expect(csv({ event_all_day: 0, event_with: 0 })[col('Blocks')]).toBe('Nobody');
    expect(csv({ event_all_day: 0, event_with: 9 })[col('Blocks')]).toBe('#9');
  });
});

describe('csvFilterOf: a fetch\'s params as an export filter', () => {
  test('drops limit and offset, keeps everything else, leaves the original alone', () => {
    const w = page(() => ({}));
    const params = { limit: 100, offset: 200, q: 'x', status: '%Open%', sort_by: 'c.case_id' };
    expect(w.csvFilterOf(params)).toEqual({ q: 'x', status: '%Open%', sort_by: 'c.case_id' });
    expect(params.limit).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The buttons: each footer's Export exports the query that drew it.

const TABS = {
  cases: {
    fn: 'tabCasesGet', kind: 'cases', prelude: 'var offsets = {}, cases; function populateCaseTypeFilter() {}',
    dom: { tabCasesLoad: 'div', tabCasesQuery: 'input=pat', tabCasesType: 'select=%', tabCasesStage: 'input=%',
      tabCasesStatus: 'input=Open', tabCasesOrder: 'input=c.case_id', tabCasesOrder2: 'input=ASC',
      casesTable: 'table', casesTableFoot: 'div' },
    filters: { q: 'pat', status: '%Open%', sort_by: 'c.case_id', sort_dir: 'ASC' },
    list: { total: 1, cases: [{ case_id: 'ABCD2345', contacts: [] }] },
  },
  contacts: {
    fn: 'tabContactsGet', kind: 'contacts', prelude: 'var offsets = {}, contacts;',
    dom: { tabContactsLoad: 'div', tabContactsQuery: 'input=pat', tabContactsSort: 'input=contact_lname', tabContactsSort2: 'input=ASC',
      tabContactsRole: 'input=judge', tabContactsBirthdays: 'input=next7', contactsTable: 'table', contactsTableFoot: 'div' },
    filters: { q: 'pat', sort_by: 'contact_lname', sort_dir: 'ASC', role: 'judge', birthdays: 'next7' },
    list: { total: 1, contacts: [{ contact_id: 1, cases: [] }] },
  },
  events: {
    fn: 'tabEventsGet', kind: 'events', prelude: 'var offsets = {}, events;',
    extra: ['escHtml', 'escAttrJSON'],
    dom: { tabEventsButton: 'input', tabEventsLoad: 'div', tabEventsType: 'input', tabEventsStatus: 'input=Scheduled',
      tabEventsTime: 'input=After', tabEventsDate1: 'input=2026-10-01', tabEventsDate2: 'input', tabEventsQ: 'input',
      tabEventsSort: 'input=upcoming', tabEventsSort2: 'input=ASC', tabEventsUnlinked: 'check', eventsTable: 'table', eventsTableFoot: 'div' },
    filters: { status: 'Scheduled', sort: 'upcoming', from: '2026-10-01' },
    list: { total: 1, data: [{ event_id: 9, event_all_day: 1 }] },
  },
  appts: {
    fn: 'tabApptsGet', kind: 'appts', prelude: 'var offsets = {}, appts, apptsLastLoad = 0; function tabApptsTypesLoad() {}',
    dom: { tabApptsButton: 'input', tabApptsLoad: 'div', tabApptsType: 'input=__default__',
      tabApptsStatus: 'input=Scheduled', tabApptsTime: 'input', tabApptsDate1: 'input',
      tabApptsDate2: 'input', tabApptsWith: 'input=6', tabApptsSort: 'input=client', tabApptsSort2: 'input=DESC',
      apptsTable: 'table', apptsTableFoot: 'div' },
    filters: { exclude_type_key: 'meeting_341', appt_with: '6', sort_by: 'client', sort_dir: 'DESC', status: 'Scheduled' },
    list: { counter: 1, appts: [{ id: 5 }] },
  },
};

describe('index.html footers: Export exports the list on screen', () => {
  test.each(Object.keys(TABS))('%s', async (name) => {
    const t = TABS[name];
    const spec = LISTS[t.kind];
    const code = `${t.prelude} ${(t.extra || []).map((f) => fnSrc(INDEX, f)).join('\n')} ${fnSrc(INDEX, t.fn)}`;
    let exporting = false;
    const w = page((url, params, n) => (exporting && n === 0 ? { [spec.totalKey]: 1 } : t.list), code, t.dom);
    w.__swalValue = { from: 1, to: 1 };
    await w[t.fn](0);
    expect(w.__footers).toHaveLength(1);
    const opts = w.__footers[0];
    expect(opts.onPrint).toBe(true);
    expect(typeof opts.onExport).toBe('function');

    w.calls.length = 0;
    exporting = true;
    await opts.onExport();
    // The probe: this list's endpoint, the fetch's own filters, no paging of its own.
    expect(w.calls[0]).toEqual({ url: spec.endpoint, method: 'GET', params: { ...t.filters, limit: 1, offset: 0 } });
    expect(w.__files).toHaveLength(1);
    expect(w.__files[0].filename.startsWith(spec.prefix + '-')).toBe(true);
  });
});

describe('Calendar list footer: Print and Export', () => {
  const CAL_DOM = {
    calxButton: 'input', calxLoad: 'div', calxFrom: 'input=2026-10-01', calxTo: 'input=2026-10-31',
    calxState: 'input=all', calxSuperseded: 'check', calxWith: 'select=', calxTable: 'table',
    calxFoot: 'div', calxKinds: 'div', calxSortBy: 'input=when', calxSortDir: 'input=ASC',
  };
  const CAL_CODE = `var calxSeq = 0, calxRows = null;
    ${['CALX_MONTHS', 'CALX_DAYS', 'CALX_KIND_ICON', 'CALX_RESOLUTION_LABEL', 'CALX_APPT_STATUS', 'CALX_SORT_KEYS']
      .map((c) => constSrc(INDEX, c)).join('\n')}
    ${['calxEsc', 'calxISO', 'calxSortRows', 'calxWhen', 'calxBadge', 'calxAnchor', 'calxWithName', 'calxApptStatus',
      'calxActions', 'calxAct', 'calxSelectedKinds', 'calxFilterSentence', 'calxGet']
      .map((f) => fnSrc(INDEX, f)).join('\n')}`;
  const ITEMS = [
    { source: 'event', source_id: 9, kind_key: 'hearing', title: HOSTILE, type_key: 'confirmation_hearing',
      starts_at: '2026-10-15 09:30:00', ends_at: '2026-10-15 10:00:00', link_type: 'case_number',
      docket: '26-12345', case_id: 'ABCD2345', display: { case_label: '26-12345' },
      attendees: [{ party: 'firm' }], state: 'live' },
    { source: 'appt', source_id: 5, kind_key: 'meeting', title: '341 Meeting', type_key: null,
      starts_at: '2026-10-16 00:00:00', all_day: true, link_type: 'contact', link_id: 1405,
      display: { contact_name: 'Pat One' }, attendees: [{ party: 'user', id: 6 }],
      state: 'resolved', resolution: 'attended' },
  ];

  async function calPage(extra = {}) {
    const w = page(() => ({ items: ITEMS, ...extra }), CAL_CODE, CAL_DOM);
    w.firmData = FIRM;
    await w.calxGet();
    return w;
  }

  test('Export writes the listed rows, with the tab\'s Attached-to and With', async () => {
    const w = await calPage();
    const btn = w.document.querySelector('#calxFoot [data-calx-foot="export"]');
    expect(btn).not.toBeNull();
    btn.click();
    expect(w.__files).toHaveLength(1);
    expect(w.__files[0].filename).toMatch(/^yisracase-calendar-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = w.__files[0].content.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Starts,Ends,All Day,Kind,Title,Type Key,Source,Source ID,Attached To,Case ID,With,State,Resolution');
    expect(lines[1]).toBe(`2026-10-15 09:30:00,2026-10-15 10:00:00,,hearing,${NEUTRAL},confirmation_hearing,event,9,26-12345,ABCD2345,Everyone,live,`);
    expect(lines[2]).toBe('2026-10-16 00:00:00,,Yes,meeting,341 Meeting,,appt,5,Pat One,,Fred Ross,resolved,attended');
    expect(lines).toHaveLength(3);
  });

  test('the list and its export follow the Order By (kind, newest letter first)', async () => {
    const w = page(() => ({ items: ITEMS }), CAL_CODE, { ...CAL_DOM, calxSortBy: 'input=kind', calxSortDir: 'input=DESC' });
    w.firmData = FIRM;
    await w.calxGet();
    const kinds = [...w.document.querySelectorAll('#calxTable tr')].slice(1).map((tr) => tr.cells[1].textContent.trim());
    expect(kinds).toEqual(['meeting', 'hearing']);
    w.document.querySelector('#calxFoot [data-calx-foot="export"]').click();
    const lines = w.__files[0].content.replace(/^\ufeff/, '').split('\r\n');
    expect(lines.slice(1).map((l) => l.split(',')[3])).toEqual(['meeting', 'hearing']);
  });

  test('a capped list keeps its warning and still exports what it lists', async () => {
    const w = await calPage({ has_more: true, limit: 2 });
    const foot = w.document.getElementById('calxFoot');
    expect(foot.textContent).toContain('capped at 2 —');
    foot.querySelector('[data-calx-foot="export"]').click();
    expect(w.__files[0].content.split('\r\n')).toHaveLength(3);
  });

  test('Print prints', async () => {
    const w = await calPage();
    let printed = 0;
    w.print = () => { printed++; };
    w.document.querySelector('#calxFoot [data-calx-foot="print"]').click();
    expect(printed).toBe(1);
  });

  test('an empty list renders no footer buttons', async () => {
    const w = page(() => ({ items: [] }), CAL_CODE, CAL_DOM);
    await w.calxGet();
    expect(w.document.querySelector('#calxFoot button')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tasks.html, booted for real (the harness of tests/tasksUi.boot.test.js):
// its footer's Export hands exportListCsv the list's query and the page's own
// transport.

describe('tasks.html footer: Export', () => {
  test('exports the loaded query through window.top.apiSend', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>',
      { url: 'https://app.4lsg.com/tasks.html', runScripts: 'dangerously' });
    DOMS.push(dom);
    const w = dom.window;
    const calls = [];
    w.apiSend = async (url, method, params) => {
      calls.push({ url, params });
      if (url === '/api/tasks') return { data: [], total: 3 };
      return {};
    };
    w.firmData = { users: [{ user: 6, user_name: 'Fred Ross' }] };
    w.user = { user: 6, user_name: 'Fred Ross' };
    w.addFile = () => {};
    w.E = (id) => w.document.getElementById(id);
    w.getTabPref = (t, k, d) => d;
    w.setTabPref = () => {};
    const footers = [];
    w.YcPager = { getLimit: (k, d) => d, setLimit() {}, renderFooter: (el, o) => footers.push(o), renderPages() {} };
    w.Toast = { fire() {} };
    w.ycFiltersToggle = () => {};
    w.ycFiltersSync = () => {};
    w.Swal = { fire: async () => ({ isConfirmed: false }), close() {}, showLoading() {}, update() {} };
    const exports = [];
    w.exportListCsv = (kind, getFilterParams, opts) => exports.push({ kind, filters: getFilterParams(), opts });
    w.eval(fnSrc(SCRIPTS, 'csvFilterOf'));

    w.document.body.innerHTML = TASKS.slice(TASKS.indexOf('<body>') + 6, TASKS.indexOf('<script>'));
    w.eval(TASKS.slice(TASKS.indexOf('<script>') + 8, TASKS.lastIndexOf('</script>')));
    await new Promise((r) => w.setTimeout(r, 50));

    expect(footers.length).toBeGreaterThan(0);
    const opts = footers[footers.length - 1];
    expect(opts.onPrint).toBe(true);
    opts.onExport();
    expect(exports).toHaveLength(1);
    expect(exports[0].kind).toBe('tasks');
    const listed = calls.filter((c) => c.url === '/api/tasks').pop().params;
    const { limit, offset, ...filters } = listed;
    expect(exports[0].filters).toEqual(filters);
    expect(exports[0].filters.status).toBe('Incomplete');
    // The page's own transport (window.top.apiSend), not scripts.js's P.apiSend.
    calls.length = 0;
    await exports[0].opts.send('/api/tasks', 'GET', { limit: 1 });
    expect(calls).toEqual([{ url: '/api/tasks', params: { limit: 1 } }]);
  });
});
