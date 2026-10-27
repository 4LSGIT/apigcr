/**
 * tests/listSorting.test.js
 *
 * The list sorts' non-SQL halves (the SQL itself: tests/listSorting.mysql.test.js,
 * gated on a scratch engine):
 *   1. contactService.birthdayDays — the BIRTHDAYS window as firm-local
 *      month-days, in upcoming order;
 *   2. GET /api/contacts refuses an unknown window before touching the DB;
 *   3. scripts.js sort() / sortSelect() — the shared header click, including
 *      the date headers' three-way cycle (upcoming → oldest → newest);
 *   4. index.html calxSortRows — the Calendar list's browser-side sort;
 *   5. the Contacts / Appts / Events tabs send what the routes read.
 * Real code throughout (scripts.js and the page functions run in jsdom); only
 * the transport and the pager are stubbed.
 *
 *   npx jest tests/listSorting.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { JSDOM } = require('jsdom');
const { Settings } = require('luxon');

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => next());

const contactService = require('../services/contactService');

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

const DOMS = [];
afterAll(() => DOMS.forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));

/** jsdom running the real scripts.js plus `code`, over `html` (the body). */
function page(html, code = '', api = async () => ({})) {
  const jsd = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`,
    { url: 'https://app.4lsg.com/', runScripts: 'dangerously' });
  DOMS.push(jsd);
  const w = jsd.window;
  // jsdom has no innerText (sort() reads and writes it); in a browser it is
  // textContent for these plain header cells.
  Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true,
  });
  w.calls = [];
  w.apiSend = async (url, method, params) => { w.calls.push({ url, params }); return api(url, params); };
  w.eval(`
    window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}),
      close() {}, showLoading() {}, update() {} };
    ${SCRIPTS}
    var YcPager = { getLimit: (k, d) => d, renderFooter() {} };
    window.__lex = (n) => eval(n);
    ${code}`);
  return w;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('contactService.birthdayDays — the window as firm-local month-days', () => {
  const bd = contactService.birthdayDays;
  const realNow = Settings.now;
  afterEach(() => { Settings.now = realNow; });

  test('next7 counts today in, and wraps past Dec 31', () => {
    expect(bd('next7', '2026-12-28')).toEqual(['1228', '1229', '1230', '1231', '0101', '0102', '0103']);
  });

  test('next30 is thirty days; a non-leap Feb 28 carries Feb 29 right after it', () => {
    const days = bd('next30', '2027-02-20');
    expect(days.slice(7, 11)).toEqual(['0227', '0228', '0229', '0301']);
    expect(days).toHaveLength(31);
    expect(days[0]).toBe('0220');
  });

  test('a leap February has its own Feb 29, once', () => {
    const days = bd('this_month', '2028-02-10');
    expect(days).toHaveLength(29);
    expect(days.filter((x) => x === '0229')).toHaveLength(1);
    expect(days[0]).toBe('0201');
  });

  test('this_month and next_month are whole calendar months', () => {
    expect(bd('this_month', '2026-10-27')).toEqual(Array.from({ length: 31 }, (_, i) => `10${String(i + 1).padStart(2, '0')}`));
    expect(bd('next_month', '2026-12-15')[0]).toBe('0101');
    expect(bd('next_month', '2026-12-15')).toHaveLength(31);
  });

  test('without a date it counts from the FIRM day, not UTC\'s', () => {
    Settings.now = () => Date.parse('2026-10-28T03:00:00Z');   // 23:00 Oct 27 in Detroit
    expect(bd('next7')[0]).toBe('1027');
  });

  test('an unknown window is null — no filter is ever built from it', () => {
    expect(bd('decade', '2026-10-27')).toBeNull();
    expect(contactService.BIRTHDAY_WINDOWS).toEqual(['next7', 'next30', 'this_month', 'next_month']);
  });
});

describe('GET /api/contacts?birthdays=', () => {
  let server; let base; let queried;
  beforeAll(async () => {
    const app = express();
    queried = 0;
    app.use((req, res, next) => {
      req.db = { query: async () => { queried++; return [[{ total: 0 }]]; } };
      next();
    });
    app.use(require('../routes/api.contacts'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  test('an unknown window is a 400 that never reaches the DB', async () => {
    const r = await fetch(`${base}/api/contacts?birthdays=decade`);
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/next7, next30, this_month, next_month/);
    expect(queried).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('scripts.js sort() — the shared header click', () => {
  const HTML = `
    <div class="tab-main">
      <select data-type="sortBy" id="by">
        <option value="upcoming">Upcoming first</option><option value="date">Date</option><option value="title">Title</option>
      </select>
      <select data-type="sortDi" id="di"><option value="ASC">A</option><option value="DESC">D</option></select>
      <button data-type="goButton" id="go"></button>
      <table><tr>
        <th id="hDate" onclick="sort(this, 'date')" data-sort-upcoming="upcoming">Date ⇅</th>
        <th id="hTitle" onclick="sort(this, 'title')">Title</th>
      </tr></table>
    </div>`;
  const setup = () => {
    const w = page(HTML);
    w.goes = 0;
    w.document.getElementById('go').onclick = () => { w.goes++; };
    const $ = (id) => w.document.getElementById(id);
    const state = () => [$('by').value, $('di').value, $('hDate').textContent, $('hTitle').textContent];
    // Dispatch on the rendered control: an inline handler resolves names
    // against the element and document first (CLAUDE.md).
    const click = (id) => $(id).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    return { w, $, state, click };
  };

  test('the date header cycles upcoming → oldest → newest → upcoming', () => {
    const { w, state, click } = setup();
    expect(state()).toEqual(['upcoming', 'ASC', 'Date ⇅', 'Title']);
    click('hDate');
    expect(state()).toEqual(['date', 'ASC', 'Date ↑', 'Title']);
    click('hDate');
    expect(state()).toEqual(['date', 'DESC', 'Date ↓', 'Title']);
    click('hDate');
    expect(state()[0]).toBe('upcoming');
    expect(state()[2]).toBe('Date ⇅');
    expect(w.goes).toBe(3);
  });

  test('any other header toggles, and a date click from it returns to upcoming', () => {
    const { state, click } = setup();
    click('hTitle');
    expect(state()).toEqual(['title', 'ASC', 'Date', 'Title ↑']);
    click('hTitle');
    expect(state()).toEqual(['title', 'DESC', 'Date', 'Title ↓']);
    click('hDate');
    expect(state()).toEqual(['upcoming', 'DESC', 'Date ⇅', 'Title']);
  });

  test('sortSelect paints the same marks from the dropdowns', () => {
    const { w, $, state } = setup();
    $('by').value = 'title'; $('di').value = 'DESC';
    w.sortSelect($('by'));
    expect(state()).toEqual(['title', 'DESC', 'Date', 'Title ↓']);
    $('by').value = 'upcoming';
    w.sortSelect($('by'));
    expect(state()).toEqual(['upcoming', 'DESC', 'Date ⇅', 'Title']);
    $('by').value = 'date'; $('di').value = 'ASC';
    w.sortSelect($('di'));
    expect(state()).toEqual(['date', 'ASC', 'Date ↑', 'Title']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('index.html calxSortRows — the Calendar list, sorted in the browser', () => {
  // The read layer's order (by day, all-day first, then time) is the input.
  const ROWS = [
    { source_id: 1, starts_at: '2026-10-01 09:00:00', kind_key: 'hearing', title: 'B', state: 'resolved', resolution: 'attended' },
    { source_id: 2, starts_at: '2026-10-19 00:00:00', all_day: true, kind_key: 'deadline', title: '', state: 'live' },
    { source_id: 3, starts_at: '2026-10-20 00:00:00', all_day: true, kind_key: 'deadline', title: 'a', state: 'live' },
    { source_id: 4, starts_at: '2026-10-20 15:00:00', kind_key: 'meeting', title: 'C', state: 'live',
      attendees: [{ party: 'user', id: 6 }] },
    { source_id: 5, starts_at: '2026-10-25 10:00:00', kind_key: 'hearing', title: 'b', state: 'live',
      link_type: 'contact', display: { contact_name: 'Pat One' }, attendees: [{ party: 'firm' }] },
  ];
  const sortOf = () => {
    const w = page('', `${constSrc(INDEX, 'CALX_SORT_KEYS')}
      function calxISO() { return '2026-10-20'; }
      ${fnSrc(INDEX, 'calxSortRows')}`);
    w.firmData = { users: [{ user: 6, user_name: 'Fred Ross' }] };
    return (by, dir) => w.calxSortRows(ROWS, by, dir).map((r) => r.source_id);
  };

  test('upcoming: today and later in calendar order, then the past newest first', () => {
    expect(sortOf()('upcoming', 'ASC')).toEqual([3, 4, 5, 2, 1]);
  });

  test('when: the read layer\'s order, or its reverse', () => {
    const s = sortOf();
    expect(s('when', 'ASC')).toEqual([1, 2, 3, 4, 5]);
    expect(s('when', 'DESC')).toEqual([5, 4, 3, 2, 1]);
  });

  test('a column: case-insensitive, blanks last both ways, ties in calendar order', () => {
    const s = sortOf();
    expect(s('title', 'ASC')).toEqual([3, 1, 5, 4, 2]);
    expect(s('title', 'DESC')).toEqual([4, 1, 5, 3, 2]);
    expect(s('kind', 'ASC')).toEqual([2, 3, 1, 5, 4]);
    expect(s('with', 'ASC')).toEqual([5, 4, 1, 2, 3]);
    expect(s('attached', 'ASC')).toEqual([5, 1, 2, 3, 4]);
    expect(s('state', 'ASC')).toEqual([1, 2, 3, 4, 5]);
  });

  test('never sorts the caller\'s array in place', () => {
    const s = sortOf();
    s('title', 'DESC');
    expect(ROWS.map((r) => r.source_id)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the tabs send what the routes read', () => {
  const input = (id, v = '') => `<input id="${id}" value="${v}">`;
  const run = async (fn, prelude, fields, extra = []) => {
    const html = Object.entries(fields).map(([id, v]) => (v === 'table' ? `<table id="${id}"><tr><th>h</th></tr></table>`
      : v === 'div' ? `<div id="${id}"></div>` : v === 'check' ? `<input type="checkbox" id="${id}">` : input(id, v))).join('');
    const w = page(html, `${prelude} ${extra.map((f) => fnSrc(INDEX, f)).join('\n')} ${fnSrc(INDEX, fn)}`,
      async () => ({ total: 0, counter: 0, data: [], appts: [], contacts: [] }));
    await w[fn](0);
    return w.calls[0].params;
  };

  const CONTACTS = { tabContactsLoad: 'div', tabContactsQuery: '', tabContactsRole: '', contactsTable: 'table', contactsTableFoot: 'div' };
  test('contacts: the two sort selects and the birthday window', async () => {
    const p = await run('tabContactsGet', 'var offsets = {}, contacts;',
      { ...CONTACTS, tabContactsSort: 'contact_dob', tabContactsSort2: 'DESC', tabContactsBirthdays: 'next30' });
    expect(p).toEqual({ limit: 100, offset: 0, sort_by: 'contact_dob', sort_dir: 'DESC', birthdays: 'next30' });
    const none = await run('tabContactsGet', 'var offsets = {}, contacts;',
      { ...CONTACTS, tabContactsSort: 'contact_lname', tabContactsSort2: 'ASC', tabContactsBirthdays: '' });
    expect(none).not.toHaveProperty('birthdays');
  });

  const APPTS = { tabApptsButton: '', tabApptsLoad: 'div', tabApptsType: '__all__', tabApptsStatus: 'All', tabApptsTime: 'All',
    tabApptsDate1: '', tabApptsDate2: '', tabApptsWith: '', apptsTable: 'table', apptsTableFoot: 'div' };
  const APPTS_PRE = 'var offsets = {}, appts, apptsLastLoad = 0; function tabApptsTypesLoad() {}';
  test('appts: upcoming sends no direction; a column sends both', async () => {
    expect(await run('tabApptsGet', APPTS_PRE, { ...APPTS, tabApptsSort: 'upcoming', tabApptsSort2: 'DESC' }))
      .toEqual({ limit: 100, offset: 0, sort_by: 'upcoming' });
    expect(await run('tabApptsGet', APPTS_PRE, { ...APPTS, tabApptsSort: 'with', tabApptsSort2: 'DESC' }))
      .toEqual({ limit: 100, offset: 0, sort_by: 'with', sort_dir: 'DESC' });
  });

  const EVENTS = { tabEventsButton: '', tabEventsLoad: 'div', tabEventsType: '', tabEventsStatus: 'Scheduled', tabEventsTime: 'All',
    tabEventsDate1: '', tabEventsDate2: '', tabEventsQ: '', tabEventsUnlinked: 'check', eventsTable: 'table', eventsTableFoot: 'div' };
  const EV = (by, dir) => run('tabEventsGet', 'var offsets = {}, events;', { ...EVENTS, tabEventsSort: by, tabEventsSort2: dir },
    ['escHtml', 'escAttrJSON']);
  test('events: upcoming, date both ways, a column', async () => {
    expect(await EV('upcoming', 'DESC')).toEqual({ limit: 100, offset: 0, status: 'Scheduled', sort: 'upcoming' });
    expect(await EV('date', 'DESC')).toEqual({ limit: 100, offset: 0, status: 'Scheduled', sort: 'desc' });
    expect(await EV('date', 'ASC')).toEqual({ limit: 100, offset: 0, status: 'Scheduled', sort: 'asc' });
    expect(await EV('title', 'DESC')).toEqual({ limit: 100, offset: 0, status: 'Scheduled', sort: 'desc', sort_by: 'title' });
  });

  test('every sortable header is wired to a value its Order By select offers', () => {
    for (const [selId, thead] of [['tabContactsSort', 'contactsTable'], ['tabApptsSort', 'apptsTable'],
      ['tabEventsSort', 'eventsTable'], ['calxSortBy', 'calxTable'], ['tabCasesOrder', 'casesTable']]) {
      const sel = INDEX.slice(INDEX.indexOf(`<select id="${selId}"`), INDEX.indexOf('</select>', INDEX.indexOf(`<select id="${selId}"`)));
      const values = [...sel.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
      const tStart = INDEX.indexOf(`<table id="${thead}"`);
      const head = INDEX.slice(tStart, INDEX.indexOf('</tr>', tStart));
      const keys = [...head.matchAll(/onclick="sort\(this, '([^']+)'\)"/g)].map((m) => m[1]);
      const ups = [...head.matchAll(/data-sort-upcoming="([^"]+)"/g)].map((m) => m[1]);
      expect(keys.length).toBeGreaterThan(0);
      for (const k of [...keys, ...ups]) expect({ selId, k, offered: values.includes(k) }).toEqual({ selId, k, offered: true });
    }
  });
});
