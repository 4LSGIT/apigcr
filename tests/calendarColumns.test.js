/**
 * Calendar tab — the column model + picker (CALX_COLUMNS), the Appts/Cases
 * twin (custom_table_view S1/S4/R1).
 *
 * Pinned here:
 *   · DEFAULTS DO NOT MOVE: the default_on set is the tab's original seven
 *     columns, in order, and each default row renders byte-for-byte what the
 *     old positional template in calxGet produced (frozen below as OLD_ROW).
 *   · Contact lists EVERY client of the row (display.contacts — a joint case
 *     shows both), links via fileLinkHtml, role as the link title; an older
 *     payload without contacts[] falls back to the single contact_name.
 *   · Case and Status (the Appts tab's vocabulary) render as specified.
 *   · Every column `sort` is an option of #calxSortBy and a calxSortRows key.
 *   · Storage: cols_off governs default_on columns, cols_on the rest,
 *     cols_order the display order; hide-everything falls back to defaults;
 *     Save re-renders from the cached rows WITHOUT a refetch.
 *
 * Run:  npx jest tests/calendarColumns.test.js
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
  const close = pairs[src[open]];
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === src[open]) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(m.index, j + 1) + ';';
  }
  throw new Error(`const ${name}: unbalanced`);
}

const CONSTS = ['CALX_MONTHS', 'CALX_DAYS', 'CALX_KIND_ICON', 'CALX_RESOLUTION_LABEL',
  'CALX_APPT_STATUS', 'CALX_SORT_KEYS', 'CALX_COLUMNS'];
const FNS = ['calxEsc', 'calxISO', 'calxSortRows', 'calxWhen', 'calxWhenParts', 'calxBadge', 'calxAnchor',
  'calxWithName', 'calxApptStatus', 'calxActions', 'calxAct', 'calxContactList', 'calxContacts', 'calxCase',
  'calxStatusText', 'calxSelectedKinds', 'calxFilterSentence', 'calxRenderRows', 'calxColsKey', 'calxColsOnKey',
  'calxColsOrderKey', 'calxColsVisible', 'calxColsRender', 'calxColsApply', 'calxColsSave'];

/** The old positional row template (calxGet before the picker), frozen. */
const OLD_ROW = `function OLD_ROW(r) {
  const kind = String(r.kind_key || 'other');
  const icon = CALX_KIND_ICON[kind] || CALX_KIND_ICON.other;
  const label = calxEsc(r.title || '(untitled)')
    + (r.type_key ? ' <span class="calx-key">' + calxEsc(r.type_key) + '</span>'
                  : ' <span class="calx-key" title="no registry type — mint one in YisraCase Config → Calendar Types">unmapped</span>');
  return '<td class="calx-when">' + calxWhen(r) + '</td>' +
    '<td class="calx-kind"><i class="fa-solid ' + icon + '"></i> ' + calxEsc(kind) + '</td>' +
    '<td>' + label + '</td>' +
    '<td>' + calxAnchor(r) + '</td>' +
    '<td>' + calxWithName(r) + '</td>' +
    '<td>' + calxBadge(r) + '</td>' +
    '<td class="calx-acts">' + calxActions(r) + '</td>';
}`;

/** The tab's real filter-bar selects, lifted from index.html. */
function sortBarHtml() {
  const a = INDEX.indexOf('<select id="calxSortBy"');
  const b = INDEX.indexOf('</select>', INDEX.indexOf('<select id="calxSortDir"')) + '</select>'.length;
  return INDEX.slice(a, b);
}

function page() {
  const jsd = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="tabCalendar" class="tab-main">${sortBarHtml()}
      <input id="calxFrom" value="2026-11-01"><input id="calxTo" value="2026-11-30">
      <select id="calxState"><option value="live">live</option></select>
      <input id="calxSuperseded" type="checkbox"><select id="calxWith"><option value="">x</option></select>
      <div id="calxKinds"></div>
      <table id="calxTable"><tr><th>h</th></tr></table>
    </div></body></html>`,
  { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  const w = jsd.window;
  // jsdom has no innerText; sort()/sortMarksSync read and write it.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  w.__fetches = 0;
  w.apiSend = async () => { w.__fetches++; return { items: [] }; };
  w.eval(`window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };\n`
    + SCRIPTS + '\n'
    + `var user = { user: 6 }; var calxRows = null; var calxSeq = 0;
       window.firmData = { users: [{ user: 6, user_name: 'Fred Ross' }] };
       function showAppt() {} function showEvent() {} function apptUpdate() {}
       function eventComplete() {} function eventCancel() {} function eventCompleteDeadline() {} function eventCancelDeadline() {}
       ${CONSTS.map((c) => constSrc(INDEX, c)).join('\n')}
       var calxColsVis = CALX_COLUMNS.filter((c) => c.default_on);
       ${FNS.map((f) => fnSrc(INDEX, f)).join('\n')}
       ${OLD_ROW}
       window.CALX_COLUMNS = CALX_COLUMNS; window.CALX_SORT_KEYS = CALX_SORT_KEYS;`);
  return w;
}

const JOINT_APPT = {
  source: 'appt', source_id: 5, kind_key: 'meeting', title: 'Initial Strategy Session', type_key: 'iss',
  starts_at: '2026-11-16 14:00:00', state: 'live', link_type: 'case', link_id: 'ABCD2345', case_id: 'ABCD2345',
  display: {
    case_label: '26-12345', contact_name: 'Pat One',
    contacts: [{ id: 1405, name: 'Pat One', role: 'Primary' }, { id: 1406, name: 'Sam One', role: 'Secondary' }],
  },
  attendees: [{ party: 'user', id: 6 }, { party: 'contact', id: 1405 }],
};
const HEARING = {
  source: 'event', source_id: 9, kind_key: 'hearing', title: 'Confirmation Hearing', type_key: 'confirmation_hearing',
  starts_at: '2026-11-20 00:00:00', all_day: true, state: 'resolved', resolution: 'completed',
  link_type: 'case_number', link_id: '26-12345', docket: '26-12345', case_id: 'ABCD2345',
  display: { case_label: '26-12345', contact_name: null, contacts: [{ id: 1405, name: 'Pat One', role: 'Primary' }] },
  attendees: [{ party: 'firm' }],
};
const OLD_PAYLOAD = {   // a read layer from before display.contacts
  source: 'event', source_id: 10, kind_key: 'deadline', title: '', type_key: null,
  starts_at: '2026-11-21 09:00:00', state: 'live', link_type: 'contact', link_id: 77,
  display: { contact_name: 'Lee Two' }, attendees: [],
};
const UNANCHORED_DOCKET = {
  source: 'event', source_id: 11, kind_key: 'hearing', title: 'Hearing', type_key: 'x',
  starts_at: '2026-11-22 10:00:00', state: 'superseded', link_type: 'case_number', docket: '26-99999',
  case_id: null, display: { case_label: null, contact_name: null, contacts: [] }, attendees: [],
};
const ROWS = [JOINT_APPT, HEARING, OLD_PAYLOAD, UNANCHORED_DOCKET];

describe('CALX_COLUMNS — defaults do not move', () => {
  test('the default_on set is the original seven, in order, with the original header text', () => {
    const w = page();
    const defs = w.CALX_COLUMNS.filter((c) => c.default_on);
    expect(defs.map((c) => c.key)).toEqual(['when', 'kind', 'title', 'attached', 'with', 'state', 'actions']);
    const staticThs = [...new JSDOM(INDEX).window.document.querySelectorAll('#calxTable th')].map((t) => t.textContent.trim());
    expect(defs.map((c) => c.label)).toEqual(staticThs);
  });

  test.each(ROWS.map((r) => [r.source + ' ' + r.source_id, r]))('default row %s renders byte-for-byte the old template', (_, r) => {
    const w = page();
    expect(w.ycColsRowHtml(w.calxColsVis, r)).toBe(w.OLD_ROW(r));
  });

  test('every sortable column names a #calxSortBy option and a calxSortRows key', () => {
    const w = page();
    const opts = [...w.document.querySelectorAll('#calxSortBy option')].map((o) => o.value);
    for (const c of w.CALX_COLUMNS.filter((x) => x.sort)) {
      expect(opts).toContain(c.sort);
      if (c.sort !== 'when') expect(Object.keys(w.CALX_SORT_KEYS)).toContain(c.sort);
    }
  });
});

describe('the new columns', () => {
  test('Contact lists EVERY client of a joint case, each a client link titled with its role', () => {
    const w = page();
    w.document.body.innerHTML = '<div id="c">' + w.calxContacts(JOINT_APPT) + '</div>';
    const links = [...w.document.querySelectorAll('#c a')];
    expect(links.map((a) => [a.textContent, a.dataset.fileKind, a.dataset.fileId, a.title]))
      .toEqual([['Pat One', 'client', '1405', 'Primary'], ['Sam One', 'client', '1406', 'Secondary']]);
    expect(w.document.getElementById('c').textContent).toBe('Pat One, Sam One');
  });

  test('a case-anchored hearing shows the case debtor; an older payload falls back to contact_name', () => {
    const w = page();
    expect(w.calxContactList(HEARING)).toEqual([{ id: 1405, name: 'Pat One', role: 'Primary' }]);
    expect(w.calxContactList(OLD_PAYLOAD)).toEqual([{ id: 77, name: 'Lee Two', role: null }]);
    expect(w.calxContacts(UNANCHORED_DOCKET)).toContain('—');
  });

  test('Case: the case link, a docket with no case as text, else a dash', () => {
    const w = page();
    w.document.body.innerHTML = '<div id="c">' + w.calxCase(JOINT_APPT) + '</div>';
    const a = w.document.querySelector('#c a');
    expect([a.textContent, a.dataset.fileKind, a.dataset.fileId]).toEqual(['26-12345', 'case', 'ABCD2345']);
    expect(w.calxCase(UNANCHORED_DOCKET)).toBe('26-99999');
    expect(w.calxCase(OLD_PAYLOAD)).toContain('—');
  });

  test('Status speaks the Appts tab vocabulary', () => {
    const w = page();
    expect(w.calxStatusText(JOINT_APPT)).toBe('Scheduled');
    expect(w.calxStatusText({ ...JOINT_APPT, state: 'resolved', resolution: 'attended' })).toBe('Attended');
    expect(w.calxStatusText({ ...JOINT_APPT, state: 'resolved', resolution: 'no_show' })).toBe('No Show');
    expect(w.calxStatusText({ ...JOINT_APPT, state: 'cancelled', resolution: 'cancelled' })).toBe('Canceled');
    expect(w.calxStatusText(UNANCHORED_DOCKET)).toBe('Rescheduled');
    expect(w.calxStatusText(HEARING)).toMatch(/^[A-Z]/);
  });

  test('Date and Time split When; an all-day row says so in Time', () => {
    const w = page();
    const col = (k) => w.CALX_COLUMNS.find((c) => c.key === k);
    expect(col('date').render(JOINT_APPT)).toBe('Mon Nov 16');
    expect(col('time').render(JOINT_APPT)).toBe('2:00 pm');
    expect(col('time').render(HEARING)).toContain('all day');
  });

  test('sorting by contact and by case', () => {
    const w = page();
    const keys = (by, dir) => w.calxSortRows(ROWS, by, dir).map((r) => r.source_id);
    expect(keys('contact', 'ASC')).toEqual([10, 9, 5, 11]);   // Lee Two, Pat One, Pat One, Sam One, (blank last)
    expect(keys('case', 'ASC').slice(-1)).toEqual([10]);      // the contact-only row has no case: last
  });
});

describe('the picker: storage, fallback, no refetch', () => {
  test('defaults with nothing stored; cols_on turns on Contact + Case; cols_off hides; order applies', () => {
    const w = page();
    expect(w.calxColsVisible().map((c) => c.key)).toEqual(['when', 'kind', 'title', 'attached', 'with', 'state', 'actions']);
    w.localStorage.setItem('yc.calendar.cols_on.6', 'contact,case');
    w.localStorage.setItem('yc.calendar.cols_off.6', 'attached,kind');
    w.localStorage.setItem('yc.calendar.cols_order.6', 'contact,case,when');
    expect(w.calxColsVisible().map((c) => c.key)).toEqual(['contact', 'case', 'when', 'title', 'with', 'state', 'actions']);
  });

  test('hiding everything falls back to the defaults; unknown stored keys drop', () => {
    const w = page();
    w.localStorage.setItem('yc.calendar.cols_off.6', 'when,kind,title,attached,with,state,actions,bogus');
    w.localStorage.setItem('yc.calendar.cols_on.6', 'bogus');
    expect(w.calxColsVisible().map((c) => c.key)).toEqual(['when', 'kind', 'title', 'attached', 'with', 'state', 'actions']);
  });

  test('Save writes the three keys and re-renders from the cached rows without a refetch', () => {
    const w = page();
    w.eval('calxRows = ' + JSON.stringify(ROWS) + ';');
    w.calxColsSave({
      orderedKeys: ['contact', 'case', 'date', 'time', 'when', 'kind', 'title', 'attached', 'with', 'state', 'status', 'actions'],
      checkedKeys: ['contact', 'case', 'date', 'time', 'status', 'actions'],
    });
    expect(w.localStorage.getItem('yc.calendar.cols_on.6')).toBe('date,time,contact,case,status');
    expect(w.localStorage.getItem('yc.calendar.cols_off.6')).toBe('when,kind,title,attached,with,state');
    expect(w.localStorage.getItem('yc.calendar.cols_order.6').split(',')[0]).toBe('contact');
    const ths = [...w.document.querySelectorAll('#calxTable th')].map((t) => t.textContent.trim());
    expect(ths).toEqual(['Contact', 'Case', 'Date', 'Time', 'Status', 'Actions']);
    const rows = w.document.querySelectorAll('#calxTable tr');
    expect(rows).toHaveLength(ROWS.length + 1);
    expect(rows[1].cells[0].textContent).toBe('Pat One, Sam One');
    expect(w.__fetches).toBe(0);
  });

  test('an empty list spans every ON-SCREEN column', () => {
    const w = page();
    w.eval('calxRows = [];');
    w.calxColsSave({ orderedKeys: w.CALX_COLUMNS.map((c) => c.key), checkedKeys: ['contact', 'case', 'actions'] });
    expect(w.document.querySelector('#calxTable tr:nth-child(2) td').getAttribute('colspan')).toBe('3');
  });
});
