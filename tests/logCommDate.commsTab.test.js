// tests/logCommDate.commsTab.test.js
//
/**
 * log-comm-date — the case/contact Communications tab
 * (public/entityCommunications.html): From date / To date / Order reach the
 * feed request (and reload it), and a log row backdated by hand shows when it
 * was really typed. The page's real script runs in JSDOM over a stub apiSend
 * (tests/entityCommunications.widget.test.js boot shape).
 *
 * Run:  npx jest tests/logCommDate.commsTab.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entityCommunications.html'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function boot(items = []) {
  const calls = [];
  const apiSend = jest.fn(async (url, method, body) => {
    calls.push({ url, method, body });
    return { items, next_offset: null, has_more: false };
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/entityCommunications.html?link_type=contact&link_id=42',
    beforeParse(window) {
      window.apiSend = apiSend;
      window.firmData = { id: 1 };
      window.entityData = { contact: { contact_id: 42 } };
    },
  });
  return { dom, w: dom.window, d: dom.window.document, calls };
}

const feedCalls = (calls) => calls.filter((c) => c.url === '/api/contacts/42/communications');

test('the defaults send no date or sort params', async () => {
  const { dom, calls } = boot();
  await settle(); await settle();
  const [first] = feedCalls(calls);
  expect(first.body).not.toHaveProperty('from_date');
  expect(first.body).not.toHaveProperty('to_date');
  expect(first.body).not.toHaveProperty('sort');
  dom.window.close();
});

test.each([
  ['comms-from', '2026-10-08', { from_date: '2026-10-08' }],
  ['comms-to', '2026-10-12', { to_date: '2026-10-12' }],
  ['comms-order', 'asc', { sort: 'asc' }],
])('changing #%s reloads the feed with it', async (id, value, expected) => {
  const { dom, w, d, calls } = boot();
  await settle(); await settle();
  const before = feedCalls(calls).length;
  const el = d.getElementById(id);
  el.value = value;
  el.dispatchEvent(new w.Event('change'));
  await settle(); await settle();
  const all = feedCalls(calls);
  expect(all.length).toBe(before + 1);
  expect(all[all.length - 1].body).toMatchObject(expected);
  dom.window.close();
});

test('a backdated log row shows "entered …"; an ordinary one does not', async () => {
  const base = { kind: 'call', direction: 'incoming', legacy: true, participant: '3135550001', preview: 'n',
    log: { type: 'call', data: {} } };
  const { dom, d } = boot([
    { ...base, key: 'log:121', id: 121, log_id: 121, at: '2026-10-09T03:30:00.000Z', entered_at: '2026-10-12T14:05:00.000Z' },
    { ...base, key: 'log:122', id: 122, log_id: 122, at: '2026-10-10T12:00:00.000Z', entered_at: null },
  ]);
  await settle(); await settle();
  const cards = [...d.querySelectorAll('.card')];
  expect(cards).toHaveLength(2);
  const entered = cards[0].querySelector('.when .entered');
  expect(entered).not.toBeNull();
  const shown = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date('2026-10-12T14:05:00.000Z'));
  expect(entered.textContent).toBe(`entered ${shown}`);
  expect(cards[0].querySelector('.when time').textContent).not.toBe('');
  expect(cards[1].querySelector('.when .entered')).toBeNull();
  dom.window.close();
});
