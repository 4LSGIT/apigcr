/**
 * scripts.js — the new-event dialog's type labels from the item-type registry
 * (U9b-P4, 2026-11-12: the fe-event_types list is retired).
 *
 *   · loadEventTypeOptions() reads GET /api/calendar-types once per page
 *     (hearing / deadline / conference / other, active only), labels grouped in
 *     that kind order, de-duplicated; concurrent callers share ONE request.
 *   · getEventTypeOptions() is the sync read: the loaded labels, else the
 *     built-in list — before the load, on a failure, on an empty answer.
 *   · newEventDialog awaits the load before it builds its Type select.
 *
 * Run:  npx jest tests/eventTypeOptions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPTS = fs.readFileSync(path.join(__dirname, '..', 'public/scripts.js'), 'utf8');
const DEFAULT = ['Confirmation Hearing', 'Docs Deadline', 'Deadline', 'Court Date', 'Hearing', 'Internal'];

function page(api) {
  const w = new JSDOM('<!DOCTYPE html><body></body>', { url: 'https://app.4lsg.com/', runScripts: 'dangerously' }).window;
  w.__calls = [];
  w.apiSend = async (url, method) => { w.__calls.push([url, method]); return api(url); };
  w.console.warn = () => {};
  w.eval(`window.Swal = { mixin: () => ({ fire: () => Promise.resolve({}) }), fire: () => Promise.resolve({}) };\n${SCRIPTS}`);
  return w;
}

const ROWS = [
  { type_key: 'cal_deadline', label: 'Claims Deadline', kind: 'deadline' },
  { type_key: 'other_x', label: 'Office Closed', kind: 'other' },
  { type_key: 'confirmation_hearing', label: 'Confirmation Hearing', kind: 'hearing' },
  { type_key: 'status_conf', label: 'Status Conference', kind: 'conference' },
  { type_key: 'dup', label: 'Confirmation Hearing', kind: 'hearing' },
  { type_key: 'blank', label: '  ', kind: 'hearing' },
];

describe('event type labels from the registry', () => {
  test('before any load: the built-in list', () => {
    const w = page(() => ({ data: ROWS }));
    expect(w.getEventTypeOptions()).toEqual(DEFAULT);
    expect(w.__calls).toEqual([]);
  });

  test('one request (active hearing/deadline/conference/other); labels in kind order, de-duplicated, blanks dropped', async () => {
    const w = page(() => ({ data: ROWS }));
    const [a, b] = await Promise.all([w.loadEventTypeOptions(), w.loadEventTypeOptions()]);
    const want = ['Confirmation Hearing', 'Claims Deadline', 'Status Conference', 'Office Closed'];
    expect([a, b]).toEqual([want, want]);
    expect(w.getEventTypeOptions()).toEqual(want);
    await w.loadEventTypeOptions();                                   // cached: no second request
    expect(w.__calls).toEqual([['/api/calendar-types?kind=hearing,deadline,conference,other&active=1', 'GET']]);
  });

  test('a failure or an empty answer keeps the built-in list, and a later call may try again', async () => {
    let fail = true;
    const w = page(() => { if (fail) throw new Error('down'); return { data: [] }; });
    expect(await w.loadEventTypeOptions()).toEqual(DEFAULT);
    fail = false;
    expect(await w.loadEventTypeOptions()).toEqual(DEFAULT);           // empty answer
    expect(w.__calls).toHaveLength(2);
  });

  test('the old setting is not read any more', async () => {
    const w = page(() => ({ data: [] }));
    w.firmData = { settings: { event_types: ['Only This'] } };
    expect(w.getEventTypeOptions()).toEqual(DEFAULT);
  });

  test('newEventDialog awaits the load before building its Type select', () => {
    const src = SCRIPTS.slice(SCRIPTS.indexOf('async function newEventDialog('));
    expect(src.indexOf('await loadEventTypeOptions();')).toBeGreaterThan(-1);
    expect(src.indexOf('await loadEventTypeOptions();')).toBeLessThan(src.indexOf('const TYPE_OPTIONS = getEventTypeOptions();'));
  });
});
