/**
 * @jest-environment node
 *
 * tests/phoneSPH.pane.test.js — the S-PH front end, booted in jsdom against a
 * stub shell apiSend (the tests/mailboxS2.pane.test.js harness; in jsdom a
 * top-level window is its own parent, so window.apiSend IS the pane's
 * P.apiSend):
 *   - public/comms.html Phone tab: lazy boot on first open, the lines rail +
 *     picker, the Texts | All | Calls toggle (All = texts AND calls per
 *     number, a call-last row previews the call; Texts = the same list with
 *     ?kind=sms, the thread never filtered; Calls = the call log), "All numbers" (every readable line at once:
 *     one row per number with its lines tagged, the thread merged with
 *     "via <line>", a From picker, the Calls view merged), a conversation as
 *     TEXT bubbles with its calls
 *     as call boxes among them (ordered by when each happened), compose only
 *     where the line grants can_send (and is active, and the number is
 *     textable), send → POST /api/phone-lines/:id/sms + a pending bubble until
 *     the webhook echo arrives, New text, stacked navigation on phones;
 *   - public/connections.html Phone Lines → Access: the grants editor round
 *     trip (list, add, tick, remove) on /api/phone-lines/:id/grants;
 *   - public/js/phoneSendable.js: the From-picker filter communicate.html and
 *     both sending forms run (and that they DO run it).
 * Mutation-checked (the S-PH report lists each).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const COMMS = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');
const CONN = fs.readFileSync(path.join(ROOT, 'public/connections.html'), 'utf8');
const PURIFY = fs.readFileSync(path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');
const COLOR = fs.readFileSync(path.join(ROOT, 'public/js/mailboxColor.js'), 'utf8');
const SENDABLE = fs.readFileSync(path.join(ROOT, 'public/js/phoneSendable.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));

const EVIL = '<img src=x onerror="window.top.__pwned=1">';

function inlineScripts(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return { bodyHtml: bodyHtml.replace(/<script[\s\S]*?<\/script>/g, ''), inline };
}

async function bootPage({ url, html, libs, handler, width = 1200, before = null }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { url, runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user_auth: 'authorized', roles: 'su' } };
  const calls = [];
  window.apiSend = async (u, method = 'GET', payload = null, headers = {}, opts = {}) => {
    calls.push({ url: u, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    return handler(u, method, payload, opts);
  };
  window.addFile = (...a) => calls.push({ addFile: a });
  window.confirm = () => true;
  if (before) before(window);
  const { bodyHtml, inline } = inlineScripts(html);
  window.document.body.innerHTML = bodyHtml;
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [...libs, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// comms.html — Phone tab
// ─────────────────────────────────────────────────────────────────────────────

const LINES = [
  { id: 1, phone_number: '2485592400', display_name: 'Stuart', provider: 'ringcentral', active: true, mms_capable: true, can_read: true, can_send: true, can_manage: false },
  { id: 3, phone_number: '2489655355', display_name: 'Rena', provider: 'quo', active: true, mms_capable: false, can_read: true, can_send: false, can_manage: false },
  { id: 7, phone_number: '2480000007', display_name: 'retired', provider: 'quo', active: false, mms_capable: false, can_read: true, can_send: true, can_manage: false },
];
const CONVOS = [
  { other_party: '3135550001', count: 3, last_id: 13, last: { id: 13, direction: 'incoming', snippet: `hi ${EVIL}`, at: '2026-10-08T14:00:00.000Z' }, contact: { contact_id: 501, name: `Pat ${EVIL}` } },
  { other_party: '22395', count: 1, last_id: 9, last: { id: 9, direction: 'incoming', snippet: 'Your code is 1234', at: '2026-10-07T14:00:00.000Z' }, contact: null },
];
const MSGS = {
  other_party: '3135550001', contact: { contact_id: 501, name: 'Pat One' }, next_cursor: '1759000000000.1',
  messages: [
    { id: 2, direction: 'outgoing', body: 'reply', at: '2026-10-08T13:00:00.000Z', logged: true },
    { id: 13, direction: 'incoming', body: `body ${EVIL}\nline two`, at: '2026-10-08T14:00:00.000Z', logged: true },
  ],
};
const CALLS = {
  calls: [
    { id: 10, direction: 'incoming', other_party: '3135550001', at: '2026-10-08T15:00:00.000Z', duration_s: 30, status: 'no-answer', unanswered: true, missed: true, logged: true, contact: { contact_id: 501, name: 'Pat One' } },
    { id: 11, direction: 'outgoing', other_party: '3135550002', at: '2026-10-08T14:00:00.000Z', duration_s: 125, status: 'completed', unanswered: false, missed: false, logged: true, contact: null },
    { id: 12, direction: 'outgoing', other_party: '22395', at: '2026-10-08T13:00:00.000Z', duration_s: 20, status: 'no-answer', unanswered: true, missed: false, logged: false, contact: null },
    { id: 15, direction: 'incoming', other_party: null, at: '2026-10-08T12:00:00.000Z', duration_s: 60, status: 'Accepted', unanswered: false, missed: false, logged: false, contact: null },
  ],
  next_cursor: null,
};
// One conversation with calls in it, in the SERVER's order (processed_at): the
// 15:10 call was recorded when it ENDED, after the 15:20 text sent during it.
const MIXED = {
  other_party: '3135550002', contact: null, next_cursor: null,
  messages: [
    { id: 30, kind: 'sms', direction: 'incoming', body: 'call me', at: '2026-10-08T15:00:00.000Z', logged: false },
    { id: 31, kind: 'sms', direction: 'outgoing', body: 'calling now', at: '2026-10-08T15:20:00.000Z', logged: false },
    { id: 32, kind: 'call', direction: 'outgoing', at: '2026-10-08T15:10:00.000Z', logged: false, duration_s: 1505, status: 'completed', unanswered: false, missed: false },
    { id: 33, kind: 'call', direction: 'incoming', at: '2026-10-08T16:00:00.000Z', logged: false, duration_s: 30, status: 'no-answer', unanswered: true, missed: true },
    { id: 34, kind: 'call', direction: 'outgoing', at: '2026-10-08T16:05:00.000Z', logged: false, duration_s: 40, status: 'no-answer', unanswered: true, missed: false },
    { id: 35, kind: 'call', direction: null, at: '2026-10-08T16:10:00.000Z', logged: false, duration_s: null, status: null, unanswered: false, missed: false },
  ],
};

function commsHandler(over = {}) {
  return (url, method, payload) => {
    const k = `${method} ${url}`;
    if (over[k]) return over[k](payload);
    if (url === '/api/mail/mailboxes') return { mailboxes: [], viewer: { su: false, role: null, can_send: false } };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages') return { messages: [], next_cursor: null };
    if (url === '/api/phone-lines/readable') return { viewer: { su: false }, lines: fresh(LINES) };
    if (/^\/api\/phone-lines\/\d+\/conversations$/.test(url)) return { conversations: fresh(CONVOS), next_cursor: null };
    if (/^\/api\/phone-lines\/\d+\/conversations\/\d+$/.test(url)) return fresh(MSGS);
    if (/^\/api\/phone-lines\/\d+\/calls$/.test(url)) return fresh(CALLS);
    if (/^\/api\/phone-lines\/\d+\/sms$/.test(url) && method === 'POST') return { status: 'success', to: payload.to };
    throw new Error(`unexpected ${method} ${url}`);
  };
}
const bootComms = (opts = {}) => bootPage({ url: 'https://app.4lsg.com/comms.html', html: COMMS, libs: [PURIFY, RENDER, COLOR], handler: commsHandler(opts.over), ...opts });
const phoneCalls = (calls) => calls.filter((c) => c.url && c.url.startsWith('/api/phone-lines'));

async function openPhone(env) {
  env.doc.getElementById('tab-phone').click();
  await tick(env.window, 60);
}

describe('comms.html — Phone tab', () => {
  test('lazy: nothing phone-shaped until the tab opens; then readable → rail + picker → Conversations of the first ACTIVE line', async () => {
    const env = await bootComms();
    const { doc, calls, errors } = env;
    expect(phoneCalls(calls)).toEqual([]);
    await openPhone(env);
    expect(errors).toEqual([]);
    expect(doc.getElementById('email').hidden).toBe(true);
    expect(doc.getElementById('phone').hidden).toBe(false);
    expect(doc.getElementById('tab-phone').getAttribute('aria-selected')).toBe('true');
    expect(phoneCalls(calls).map((c) => c.url)).toEqual(['/api/phone-lines/readable', '/api/phone-lines/1/conversations']);
    const rail = [...doc.querySelectorAll('#ph-rail-lines .vitem')];
    expect(rail.map((b) => b.dataset.line)).toEqual(['all', '1', '3', '7']);
    expect(rail[0].textContent).toBe('All numbers3 lines');
    expect(rail[0].getAttribute('aria-current')).toBeNull();
    expect(rail[1].getAttribute('aria-current')).toBe('true');
    expect(rail[1].querySelector('.acc').textContent).toBe('R·S');
    expect(rail[2].querySelector('.acc').textContent).toBe('R');
    expect(rail[3].querySelector('.sub').textContent).toBe('(248) 000-0007 · inactive');
    expect([...doc.getElementById('ph-line-sel').options].map((o) => o.value)).toEqual(['all', '1', '3', '7']);
    // the toggle: Texts | All | Calls, All by default (no kind on the list read)
    expect(['ph-v-sms', 'ph-v-all', 'ph-v-calls'].map((id) => [doc.getElementById(id).textContent, doc.getElementById(id).getAttribute('aria-pressed')]))
      .toEqual([['Texts', 'false'], ['All', 'true'], ['Calls', 'false']]);
    expect(phoneCalls(calls)[1].payload).toBeNull();
    expect(doc.querySelectorAll('#ph-list .msg')).toHaveLength(2);
    // re-opening the tab does not re-boot
    doc.getElementById('tab-email').click();
    doc.getElementById('tab-phone').click();
    await tick(env.window);
    expect(phoneCalls(calls).filter((c) => c.url === '/api/phone-lines/readable')).toHaveLength(1);
  });

  test('hostile bodies, snippets and names are TEXT — no element is created from them', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window } = env;
    const row = doc.querySelector('#ph-list .msg');
    expect(row.textContent).toContain(EVIL);
    expect(row.querySelector('img')).toBeNull();
    row.click();
    await tick(window, 60);
    const bubbles = [...doc.querySelectorAll('#ph-body .bub')];
    expect(bubbles.map((b) => b.className)).toEqual(['bub out', 'bub in']);
    expect(bubbles[1].textContent).toContain(EVIL);
    expect(doc.querySelector('#ph-body img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  test('a failed outbound text carries the delivery chip (phone-delivery S3); everything else shows none', async () => {
    const thread = {
      other_party: '3135550001', contact: null, next_cursor: null,
      messages: [
        { id: 60, kind: 'sms', direction: 'outgoing', body: 'please call us', at: '2026-10-08T13:00:00.000Z', logged: true,
          delivery: { state: 'failed', reason: 'unreachable', code: 'SMS-CAR-411' } },
        { id: 61, kind: 'sms', direction: 'outgoing', body: 'second try', at: '2026-10-08T13:05:00.000Z', logged: true,
          delivery: { state: 'failed', reason: 'definitely_new_reason', code: null } },
        { id: 62, kind: 'sms', direction: 'outgoing', body: 'went through', at: '2026-10-08T13:10:00.000Z', logged: true,
          delivery: { state: 'delivered', reason: null, code: null } },
        { id: 63, kind: 'sms', direction: 'incoming', body: 'got it', at: '2026-10-08T13:15:00.000Z', logged: true, delivery: null },
      ],
    };
    const env = await bootComms({ over: { 'GET /api/phone-lines/1/conversations/3135550001': () => fresh(thread) } });
    await openPhone(env);
    const { doc, window, errors } = env;
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 60);
    expect(errors).toEqual([]);
    const chipOf = (id) => doc.querySelector(`#ph-body .bub[data-id="${id}"] .ph-fail`);
    expect(chipOf('60').textContent).toContain("Not delivered — this number can't receive texts");
    expect(chipOf('60').title).toBe('Provider code SMS-CAR-411');           // raw code: tooltip only
    expect(chipOf('60').textContent).not.toContain('SMS-CAR-411');
    // an unknown reason degrades to the generic line, never breaks the bubble
    expect(chipOf('61').textContent).toContain('Not delivered — the carrier reported a failure');
    expect(chipOf('61').title).toBe('');
    // delivered and incoming texts carry no chip, and the words still render
    expect(chipOf('62')).toBeNull();
    expect(chipOf('63')).toBeNull();
    expect(doc.querySelector('#ph-body .bub[data-id="62"]').textContent).toContain('went through');
  });

  test('compose: shown on a can_send + active line for a textable number; hidden (with a reason) otherwise', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window } = env;
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(false);
    expect(doc.getElementById('ph-new').hidden).toBe(false);
    // a short code cannot be texted back
    doc.querySelector('#ph-list .msg[data-party="22395"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(true);
    expect(doc.getElementById('ph-nosend').textContent).toMatch(/short code/);
    // read-only line (Rena, line 3)
    doc.querySelector('#ph-rail-lines .vitem[data-line="3"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-new').hidden).toBe(true);
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(true);
    expect(doc.getElementById('ph-nosend').textContent).toMatch(/not send/);
    // inactive line with a send grant still cannot send
    doc.querySelector('#ph-rail-lines .vitem[data-line="7"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-new').hidden).toBe(true);
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(true);
    expect(doc.getElementById('ph-nosend').textContent).toMatch(/inactive/);
  });

  test('send: POST {to, message} to the open line; a pending bubble until the echo arrives; the conversation is re-read', async () => {
    let echoed = false;
    const env = await bootComms({
      over: {
        'GET /api/phone-lines/1/conversations/3135550001': () => {
          const m = fresh(MSGS);
          if (echoed) m.messages.push({ id: 20, direction: 'outgoing', body: 'On my way', at: new Date().toISOString(), logged: true });
          return m;
        },
      },
    });
    await openPhone(env);
    const { doc, window, calls } = env;
    window.PH_RECHECK_MS = [30];
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    doc.getElementById('ph-text').value = '  On my way ';
    doc.getElementById('ph-send').click();
    await tick(window, 20);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.payload]))
      .toEqual([['/api/phone-lines/1/sms', { to: '3135550001', message: 'On my way' }]]);
    expect(doc.querySelector('#ph-body .bub.pending').textContent).toMatch(/On my way.*waiting/s);
    expect(doc.getElementById('ph-text').value).toBe('');
    echoed = true;
    await tick(window, 120);
    expect(doc.querySelector('#ph-body .bub.pending')).toBeNull();
    expect([...doc.querySelectorAll('#ph-body .bub.out')].map((b) => b.dataset.id)).toEqual(['2', '20']);
  });

  test('a refused send says why and keeps the text', async () => {
    const env = await bootComms({ over: { 'POST /api/phone-lines/1/sms': () => { throw new Error('Send permission required on this phone line'); } } });
    await openPhone(env);
    const { doc, window } = env;
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    doc.getElementById('ph-text').value = 'hello';
    doc.getElementById('ph-send').click();
    await tick(window, 40);
    expect(doc.getElementById('toast').textContent).toMatch(/Not sent: Send permission required/);
    expect(doc.getElementById('ph-text').value).toBe('hello');
    expect(doc.querySelector('#ph-body .bub.pending')).toBeNull();
  });

  test('Calls: missed rows marked, durations; a call row opens the conversation with that number — short codes too, never a number-less call', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window, calls } = env;
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/1/calls');
    const rows = [...doc.querySelectorAll('#ph-list .msg')];
    expect(rows[0].classList.contains('missed')).toBe(true);
    expect(rows[0].textContent).toMatch(/Missed call/);
    expect(rows[1].textContent).toMatch(/Outgoing · 2m 05s/);
    expect(rows[2].textContent).toMatch(/Outgoing · no answer/);
    expect(rows[2].classList.contains('missed')).toBe(false);
    // direction: the Log's icons (in = to-bracket, out = from-bracket), with a tooltip
    expect(rows.map((r) => [r.querySelector('.r2 .dir i').className, r.querySelector('.r2 .dir').title])).toEqual([
      ['fa-solid fa-arrow-right-to-bracket', 'Incoming'], ['fa-solid fa-arrow-right-from-bracket', 'Outgoing'],
      ['fa-solid fa-arrow-right-from-bracket', 'Outgoing'], ['fa-solid fa-arrow-right-to-bracket', 'Incoming'],
    ]);
    rows[1].click();
    await tick(window, 60);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/1/conversations/3135550002');
    // a short code's calls live in its conversation too (it just can't be texted back)
    rows[2].click();
    await tick(window, 60);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/1/conversations/22395');
    expect(doc.getElementById('ph-compose').hidden).toBe(true);
    // a call with no other party opens nothing
    expect(rows[3].getAttribute('role')).toBeNull();
    const before = calls.length;
    rows[3].click();
    await tick(window, 40);
    expect(calls.length).toBe(before);
  });

  test('a conversation shows its CALLS among the texts: one box each, on the caller\'s side, ordered by when it happened', async () => {
    const env = await bootComms({ over: { 'GET /api/phone-lines/1/conversations/3135550002': () => fresh(MIXED) } });
    await openPhone(env);
    const { doc, window, errors } = env;
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    doc.querySelector('#ph-list .msg[data-call="11"]').click();
    await tick(window, 60);
    expect(errors).toEqual([]);
    const bubs = [...doc.querySelectorAll('#ph-body .bub')];
    // by `at`: the 15:10 call sits between the 15:00 and 15:20 texts though the server sent it after both
    expect(bubs.map((b) => b.dataset.id)).toEqual(['30', '32', '31', '33', '34', '35']);
    expect(bubs.map((b) => b.className)).toEqual(['bub in', 'bub call out', 'bub out', 'bub call in missed', 'bub call out', 'bub call in']);
    expect(bubs.filter((b) => b.dataset.kind === 'call').map((b) => b.querySelector('.ct').textContent))
      .toEqual(['Outgoing call · 25m 05s', 'Missed call', 'Outgoing call · no answer', 'Call']);
    expect(bubs.filter((b) => b.dataset.kind === 'call').map((b) => b.querySelector('.ct i').className))
      .toEqual(['fa-solid fa-phone', 'fa-solid fa-phone-slash', 'fa-solid fa-phone-slash', 'fa-solid fa-phone']);
    expect(bubs[1].querySelector('.bt').textContent).not.toBe('');
    // a call box carries no text body of its own
    expect(bubs[1].childNodes).toHaveLength(2);
  });

  test('Conversations list: a row whose last item is a CALL previews the call (missed in red, no "You:"); a text-last row is unchanged', async () => {
    const callLast = (id, party, over) => ({ other_party: party, count: 1, last_id: id, contact: null, last: { id, kind: 'call', at: '2026-10-08T16:00:00.000Z', duration_s: 185, status: 'completed', unanswered: false, missed: false, ...over } });
    const rows = [
      callLast(40, '3135550040', { direction: 'incoming', status: 'no-answer', unanswered: true, missed: true, duration_s: 30 }),
      callLast(39, '3135550039', { direction: 'outgoing', status: 'no-answer', unanswered: true }),
      callLast(38, '3135550038', { direction: 'incoming' }),
      { other_party: '3135550037', count: 2, last_id: 37, contact: null, last: { id: 37, kind: 'sms', direction: 'outgoing', snippet: 'see you then', at: '2026-10-08T15:00:00.000Z' } },
    ];
    const env = await bootComms({ over: { 'GET /api/phone-lines/1/conversations': () => ({ conversations: fresh(rows), next_cursor: null }) } });
    await openPhone(env);
    const { doc, errors } = env;
    expect(errors).toEqual([]);
    const snips = [...doc.querySelectorAll('#ph-list .msg .snippet')];
    expect(snips.map((x) => x.textContent)).toEqual(['Missed call', 'Outgoing call · no answer', 'Incoming call · 3m 05s', 'You: see you then']);
    expect(snips.map((x) => x.className)).toEqual(['snippet call missed', 'snippet call', 'snippet call', 'snippet']);
    expect(snips.slice(0, 3).map((x) => x.querySelector('i').className)).toEqual(['fa-solid fa-phone-slash', 'fa-solid fa-phone-slash', 'fa-solid fa-phone']);
    // beside the phone icon: the Log's direction icon + tooltip, as on the Calls rows
    expect(snips.slice(0, 3).map((x) => [x.querySelector('.dir i').className, x.querySelector('.dir').title])).toEqual([
      ['fa-solid fa-arrow-right-to-bracket', 'Incoming'], ['fa-solid fa-arrow-right-from-bracket', 'Outgoing'], ['fa-solid fa-arrow-right-to-bracket', 'Incoming'],
    ]);
    expect(snips[3].querySelector('i')).toBeNull();
  });

  test('a number no contact holds: the title is the number alone (never "null") + Add to contact → the shell dialog with the first-seen day; attaching re-reads and names it', async () => {
    let attached = false;
    const dialogs = [];
    const unknown = { other_party: '3135489162', contact: null, next_cursor: null, messages: [{ id: 50, kind: 'sms', direction: 'incoming', body: 'loan offer', at: '2026-10-12T16:10:00.000Z', logged: false }] };
    const env = await bootComms({
      before: (w) => { w.OrphanAdoptDialog = (value, type, onDone, opts) => { dialogs.push({ value, type, opts }); attached = true; onDone({ action: 'attached', contact_id: 777 }); }; },
      over: {
        'GET /api/phone-lines/1/conversations': () => ({ conversations: [{ other_party: '3135489162', count: 1, last_id: 50, contact: null, last: { id: 50, kind: 'sms', direction: 'incoming', snippet: 'loan offer', at: '2026-10-12T16:10:00.000Z' } }], next_cursor: null }),
        'GET /api/phone-lines/1/conversations/3135489162': () => (attached ? { ...fresh(unknown), contact: { contact_id: 777, name: 'Emily Northwood' } } : fresh(unknown)),
        'GET /api/phone-lines/first-seen': (q) => ({ number: q.number, first_seen: '2026-06-19' }),
      },
    });
    await openPhone(env);
    const { doc, window, calls, errors } = env;
    doc.querySelector('#ph-list .msg[data-party="3135489162"]').click();
    await tick(window, 60);
    expect(errors).toEqual([]);
    expect(doc.getElementById('ph-title').textContent).toBe('(313) 548-9162');
    expect(doc.getElementById('ph-contact').hidden).toBe(true);
    const add = doc.getElementById('ph-addc');
    expect(add.hidden).toBe(false);
    add.click();
    await tick(window, 80);
    expect(calls.filter((c) => c.url === '/api/phone-lines/first-seen').map((c) => c.payload)).toEqual([{ number: '3135489162' }]);
    expect(dialogs).toEqual([{ value: '3135489162', type: 'phone', opts: { earliest: '2026-06-19' } }]);
    // the attach callback re-read the conversation: the name is the title now, and the add button is gone
    expect(doc.getElementById('ph-title').textContent).toBe('Emily Northwood(313) 548-9162');
    expect(doc.getElementById('ph-contact').hidden).toBe(false);
    expect(add.hidden).toBe(true);
  });

  test('Add to contact: never for a known contact or a short code; a pane without the shell dialog says so', async () => {
    const bare = (party) => () => ({ other_party: party, contact: null, next_cursor: null, messages: [] });
    const env = await bootComms({ over: { 'GET /api/phone-lines/1/conversations/22395': bare('22395'), 'GET /api/phone-lines/1/conversations/3135550099': bare('3135550099') } });
    await openPhone(env);
    const { doc, window } = env;
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-addc').hidden).toBe(true);
    expect(doc.getElementById('ph-title').textContent).toBe('Pat One(313) 555-0001');
    doc.querySelector('#ph-list .msg[data-party="22395"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-addc').hidden).toBe(true);
    expect(doc.getElementById('ph-title').textContent).toBe('22395');
    // a number with no contact, but no OrphanAdoptDialog in this window
    window.eval("openConversation('3135550099', null)");
    await tick(window, 60);
    doc.getElementById('ph-addc').click();
    await tick(window, 40);
    expect(doc.getElementById('toast').textContent).toMatch(/needs the app window/);
  });

  test('a text with no words (a picture / file message) says "Attachment" — in the bubble and in the list', async () => {
    const env = await bootComms({
      over: {
        'GET /api/phone-lines/1/conversations': () => ({ conversations: [
          { other_party: '3135550001', count: 2, last_id: 61, contact: null, last: { id: 61, kind: 'sms', direction: 'incoming', snippet: '', at: '2026-10-12T16:10:00.000Z' } },
          { other_party: '3135550002', count: 1, last_id: 60, contact: null, last: { id: 60, kind: 'sms', direction: 'outgoing', snippet: '', at: '2026-10-12T16:00:00.000Z' } },
        ], next_cursor: null }),
        'GET /api/phone-lines/1/conversations/3135550001': () => ({ other_party: '3135550001', contact: null, next_cursor: null, messages: [
          { id: 59, kind: 'sms', direction: 'incoming', body: 'see picture', at: '2026-10-12T16:09:00.000Z', logged: false },
          { id: 61, kind: 'sms', direction: 'incoming', body: ' ', at: '2026-10-12T16:10:00.000Z', logged: false },
        ] }),
      },
    });
    await openPhone(env);
    const { doc, window } = env;
    expect([...doc.querySelectorAll('#ph-list .msg .snippet')].map((x) => x.textContent)).toEqual(['Attachment', 'You: Attachment']);
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    const bubs = [...doc.querySelectorAll('#ph-body .bub')];
    expect(bubs[0].querySelector('.ph-att')).toBeNull();
    expect(bubs[1].querySelector('.ph-att').textContent).toBe('Attachment — not shown here yet');
    expect(bubs[1].querySelector('.ph-att i').className).toBe('fa-solid fa-paperclip');
    expect(bubs[1].querySelector('.att')).toBeNull(); // the Email tab's chip class — bordered, not ours
  });

  test('every segmented button carries data-label = its text (it reserves the bold width — a toggle never resizes the bar)', () => {
    const dom = new JSDOM(COMMS);
    DOMS.push(dom);
    const btns = [...dom.window.document.querySelectorAll('.seg button')];
    expect(btns.map((b) => b.id)).toEqual(['f-inbox', 'f-sent', 'f-folders', 'f-case-any', 'f-case-on', 'f-case-off', 'ph-v-sms', 'ph-v-all', 'ph-v-calls']); // + S2P's case three-way (D.5)
    expect(btns.map((b) => b.getAttribute('data-label'))).toEqual(btns.map((b) => b.textContent.trim()));
    expect(COMMS).toMatch(/\.seg button\[data-label\]::after \{ content: attr\(data-label\); font-weight: 700; height: 0;/);
  });

  test('an empty All list says texts OR calls; an empty Texts list says texts', async () => {
    const env = await bootComms({ over: { 'GET /api/phone-lines/1/conversations': () => ({ conversations: [], next_cursor: null }) } });
    await openPhone(env);
    expect(env.doc.getElementById('ph-list').textContent).toBe('No texts or calls on this line.');
    env.doc.getElementById('ph-v-sms').click();
    await tick(env.window, 60);
    expect(env.doc.getElementById('ph-list').textContent).toBe('No texts on this line.');
  });

  test('Texts: the conversation list with kind=sms on every page (Load more too); the opened thread is NOT filtered; All drops the kind', async () => {
    const env = await bootComms({
      over: {
        'GET /api/phone-lines/1/conversations': (q) => (q && q.cursor
          ? { conversations: [fresh(CONVOS[1])], next_cursor: null }
          : { conversations: [fresh(CONVOS[0])], next_cursor: '13' }),
      },
    });
    await openPhone(env);
    const { doc, window, calls } = env;
    const lists = () => calls.filter((c) => c.url === '/api/phone-lines/1/conversations').map((c) => c.payload);
    doc.getElementById('ph-v-sms').click();
    await tick(window, 60);
    expect(['ph-v-sms', 'ph-v-all', 'ph-v-calls'].map((id) => doc.getElementById(id).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    doc.getElementById('ph-more').click();
    await tick(window, 60);
    expect(lists()).toEqual([null, { kind: 'sms' }, { kind: 'sms', cursor: '13' }]);
    expect([...doc.querySelectorAll('#ph-list .msg')].map((r) => r.dataset.party)).toEqual(['3135550001', '22395']);
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/phone-lines/1/conversations/3135550001').map((c) => c.payload)).toEqual([null]);
    doc.getElementById('ph-v-all').click();
    await tick(window, 60);
    expect(lists().slice(-1)).toEqual([null]);
  });

  test('New text from Calls lands the list on All; from Texts the list stays Texts', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window } = env;
    const pressed = () => ['ph-v-sms', 'ph-v-all', 'ph-v-calls'].filter((id) => doc.getElementById(id).getAttribute('aria-pressed') === 'true');
    const send = async (to) => {
      doc.getElementById('ph-new').click();
      doc.getElementById('ph-new-to').value = to;
      doc.getElementById('ph-new-text').value = 'hi';
      doc.getElementById('ph-new-send').click();
      await tick(window, 60);
    };
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    await send('3135550007');
    expect(pressed()).toEqual(['ph-v-all']);
    doc.getElementById('ph-v-sms').click();
    await tick(window, 60);
    await send('3135550008');
    expect(pressed()).toEqual(['ph-v-sms']);
  });

  test('a number with only calls opens a conversation of call boxes; the empty one says texts OR calls', async () => {
    const onlyCalls = { other_party: '3135550002', contact: null, next_cursor: null, messages: [fresh(MIXED.messages[3])] };
    const env = await bootComms({
      over: {
        'GET /api/phone-lines/1/conversations/3135550002': () => fresh(onlyCalls),
        'GET /api/phone-lines/1/conversations/3135550001': () => ({ other_party: '3135550001', contact: null, next_cursor: null, messages: [] }),
      },
    });
    await openPhone(env);
    const { doc, window } = env;
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    doc.querySelector('#ph-list .msg[data-call="11"]').click();
    await tick(window, 60);
    expect([...doc.querySelectorAll('#ph-body .bub')].map((b) => b.className)).toEqual(['bub call in missed']);
    expect(doc.getElementById('ph-compose').hidden).toBe(false); // a 10-digit caller can be texted back
    doc.querySelector('#ph-list .msg[data-call="10"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-body').textContent).toMatch(/No texts or calls with this number yet/);
  });

  test('switching lines remembers the line, drops the open conversation; the remembered line boots next time', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window } = env;
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-head').hidden).toBe(false);
    const sel = doc.getElementById('ph-line-sel');
    sel.value = '3';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 60);
    expect(doc.getElementById('ph-head').hidden).toBe(true);
    expect(window.localStorage.getItem('yc-comms-phone-line')).toBe('3');
    const env2 = await bootComms({ before: (w) => w.localStorage.setItem('yc-comms-phone-line', '3') });
    await openPhone(env2);
    expect(env2.calls.map((c) => c.url)).toContain('/api/phone-lines/3/conversations');
  });

  test('no readable lines: the list explains, the controls are off', async () => {
    const env = await bootComms({ over: { 'GET /api/phone-lines/readable': () => ({ viewer: { su: false }, lines: [] }) } });
    await openPhone(env);
    const { doc, calls } = env;
    expect(doc.getElementById('ph-list').textContent).toMatch(/No phone lines are shared with you/);
    expect(['ph-v-sms', 'ph-v-all', 'ph-v-calls', 'ph-q'].map((id) => doc.getElementById(id).disabled)).toEqual([true, true, true, true]);
    expect(doc.getElementById('ph-new').hidden).toBe(true);
    expect(phoneCalls(calls).map((c) => c.url)).toEqual(['/api/phone-lines/readable']);
  });

  test('New text: refuses a non-US number inline; sends and opens that conversation', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window, calls } = env;
    doc.getElementById('ph-new').click();
    expect(doc.getElementById('ph-new-backdrop').classList.contains('open')).toBe(true);
    doc.getElementById('ph-new-to').value = '22395';
    doc.getElementById('ph-new-text').value = 'hi';
    doc.getElementById('ph-new-send').click();
    await tick(window);
    expect(doc.getElementById('ph-new-msg').textContent).toMatch(/10 digits/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    doc.getElementById('ph-new-to').value = '+1 (313) 555-0007';
    doc.getElementById('ph-new-send').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.payload)).toEqual([{ to: '3135550007', message: 'hi' }]);
    expect(doc.getElementById('ph-new-backdrop').classList.contains('open')).toBe(false);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/1/conversations/3135550007');
  });

  test('phone width: a conversation stacks over the list; Back returns', async () => {
    const env = await bootComms({ width: 375 });
    await openPhone(env);
    const { doc, window } = env;
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 60);
    expect(doc.getElementById('phone').classList.contains('show-thread')).toBe(true);
    doc.getElementById('ph-back').click();
    expect(doc.getElementById('phone').classList.contains('show-thread')).toBe(false);
  });

  test('the contact button opens the contact through the shell', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc, window, calls } = env;
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    const b = doc.getElementById('ph-contact');
    expect(b.hidden).toBe(false);
    b.click();
    expect(calls.find((c) => c.addFile)).toEqual({ addFile: ['Pat One', 'client', '501'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comms.html — All numbers
// ─────────────────────────────────────────────────────────────────────────────

const ALL_LINES = [
  { id: 1, phone_number: '2485592400', display_name: 'Stuart', provider: 'ringcentral', active: true, mms_capable: true, can_read: true, can_send: true, can_manage: false },
  { id: 3, phone_number: '2489655355', display_name: 'Rena', provider: 'quo', active: true, mms_capable: false, can_read: true, can_send: false, can_manage: false },
  { id: 4, phone_number: '2486213656', display_name: 'rc2', provider: 'ringcentral', active: true, mms_capable: true, can_read: true, can_send: true, can_manage: false },
];
const ALL_CONVOS = [
  { other_party: '3135550001', count: 4, last_id: 13, line_ids: [1, 3, 4], contact: { contact_id: 501, name: 'Pat One' }, last: { id: 13, kind: 'sms', direction: 'incoming', snippet: 'on rc2 now', at: '2026-10-08T16:00:00.000Z', line_id: 4 } },
  { other_party: '3135550004', count: 1, last_id: 12, line_ids: [3], contact: null, last: { id: 12, kind: 'call', direction: 'incoming', at: '2026-10-08T15:00:00.000Z', duration_s: 20, status: 'no-answer', unanswered: true, missed: true, line_id: 3 } },
];
const ALL_THREAD = {
  other_party: '3135550001', contact: { contact_id: 501, name: 'Pat One' }, line_ids: [1, 3, 4], next_cursor: null,
  messages: [
    { id: 1, kind: 'sms', direction: 'incoming', body: 'hello Rena', at: '2026-10-08T12:00:00.000Z', logged: true, line_id: 3 },
    { id: 2, kind: 'sms', direction: 'outgoing', body: 'reply from Stuart', at: '2026-10-08T13:00:00.000Z', logged: true, line_id: 1 },
    { id: 10, kind: 'call', direction: 'incoming', at: '2026-10-08T14:00:00.000Z', logged: false, duration_s: 65, status: 'Accepted', unanswered: false, missed: false, line_id: 3 },
    { id: 13, kind: 'sms', direction: 'incoming', body: 'on rc2 now', at: '2026-10-08T16:00:00.000Z', logged: true, line_id: 4 },
  ],
};
const ALL_CALLS = { calls: [
  { id: 12, direction: 'incoming', other_party: '3135550004', at: '2026-10-08T15:00:00.000Z', duration_s: 20, status: 'no-answer', unanswered: true, missed: true, logged: false, contact: null, line_id: 3 },
  { id: 10, direction: 'incoming', other_party: '3135550001', at: '2026-10-08T14:00:00.000Z', duration_s: 65, status: 'Accepted', unanswered: false, missed: false, logged: false, contact: { contact_id: 501, name: 'Pat One' }, line_id: 3 },
], next_cursor: null };

function allOver(extra = {}) {
  return {
    'GET /api/phone-lines/readable': () => ({ viewer: { su: false }, lines: fresh(ALL_LINES) }),
    'GET /api/phone-lines/all/conversations': () => ({ all: true, conversations: fresh(ALL_CONVOS), next_cursor: null }),
    'GET /api/phone-lines/all/conversations/3135550001': () => ({ all: true, ...fresh(ALL_THREAD) }),
    'GET /api/phone-lines/all/calls': () => ({ all: true, ...fresh(ALL_CALLS) }),
    ...extra,
  };
}
async function openAll(env) {
  await openPhone(env);
  env.doc.querySelector('#ph-rail-lines .vitem[data-line="all"]').click();
  await tick(env.window, 60);
}

describe('comms.html — All numbers', () => {
  test('All numbers leads the rail and the picker; choosing it loads every line at once, tags each row with its lines, and is remembered', async () => {
    const env = await bootComms({ over: allOver() });
    await openPhone(env);
    const { doc, window, calls, errors } = env;
    expect(doc.querySelectorAll('#ph-list .ln-tags')).toHaveLength(0); // a single line's list carries no tags
    await openAll(env);
    expect(errors).toEqual([]);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/all/conversations');
    expect(doc.querySelector('#ph-rail-lines .vitem[data-line="all"]').getAttribute('aria-current')).toBe('true');
    expect(doc.getElementById('ph-line-sel').value).toBe('all');
    expect(window.localStorage.getItem('yc-comms-phone-line')).toBe('all');
    const rows = [...doc.querySelectorAll('#ph-list .msg')];
    expect(rows.map((r) => [...r.querySelectorAll('.ln-tag')].map((t) => t.textContent))).toEqual([['Stuart', 'Rena', 'rc2'], ['Rena']]);
    expect(rows[1].querySelector('.snippet').textContent).toBe('Missed call');
    // the next boot opens All numbers again
    const env2 = await bootComms({ over: allOver(), before: (w) => w.localStorage.setItem('yc-comms-phone-line', 'all') });
    await openPhone(env2);
    expect(phoneCalls(env2.calls).map((c) => c.url)).toEqual(['/api/phone-lines/readable', '/api/phone-lines/all/conversations']);
  });

  test('a merged conversation: every line\'s texts and calls, each "via <line>"; the head names the lines', async () => {
    const env = await bootComms({ over: allOver() });
    await openAll(env);
    const { doc, window, calls } = env;
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/all/conversations/3135550001');
    expect([...doc.querySelectorAll('#ph-body .bub .bt')].map((b) => b.textContent.split(' · via ')[1])).toEqual(['Rena', 'Stuart', 'Rena', 'rc2']);
    expect(doc.getElementById('ph-title').textContent).toBe('Pat One(313) 555-0001 · Stuart, Rena, rc2');
  });

  test('From picker: only sendable lines; defaults to the line of the newest TEXT you can send from (not a newer call); your pick sticks; Send posts to THAT line', async () => {
    let echoed = false;
    const env = await bootComms({ over: allOver({
      'GET /api/phone-lines/all/conversations/3135550001': () => {
        const t = { all: true, ...fresh(ALL_THREAD) };
        // the newest EVENT is a call on Stuart's line — the default still follows the newest text (rc2)
        t.messages.push({ id: 14, kind: 'call', direction: 'outgoing', at: '2026-10-08T17:00:00.000Z', logged: false, duration_s: 30, status: 'Call connected', unanswered: false, missed: false, line_id: 1 });
        if (echoed) t.messages.push({ id: 20, kind: 'sms', direction: 'outgoing', body: 'on rc2 please', at: new Date().toISOString(), logged: true, line_id: 4 });
        return t;
      },
    }) });
    await openAll(env);
    const { doc, window, calls } = env;
    window.PH_RECHECK_MS = [30];
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(false);
    expect(doc.getElementById('ph-from').hidden).toBe(true);
    expect(doc.getElementById('ph-from-pick').hidden).toBe(false);
    const sel = doc.getElementById('ph-from-sel');
    expect([...sel.options].map((o) => o.value)).toEqual(['1', '4']); // Rena's line is read-only
    expect(sel.value).toBe('4');                                       // the newest text (13) came in on rc2
    sel.value = '1';
    sel.dispatchEvent(new window.Event('change'));
    window.eval("openConversation('3135550001', null, { silent: true })");
    await tick(window, 60);
    expect(sel.value).toBe('1');                                       // a quiet re-read keeps your pick
    sel.value = '4';                                                   // …and back: send from rc2 (not the first sendable line)
    sel.dispatchEvent(new window.Event('change'));
    doc.getElementById('ph-text').value = 'on rc2 please';
    doc.getElementById('ph-send').click();
    await tick(window, 20);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.payload])).toEqual([['/api/phone-lines/4/sms', { to: '3135550001', message: 'on rc2 please' }]]);
    expect(doc.querySelector('#ph-body .bub.pending').textContent).toMatch(/Sent via rc2 — waiting/);
    echoed = true;
    await tick(window, 120);
    expect(doc.querySelector('#ph-body .bub.pending')).toBeNull();
  });

  test('New text from All numbers picks its From line; the merged Calls view tags each call with its line', async () => {
    const env = await bootComms({ over: allOver({ 'GET /api/phone-lines/all/conversations/3135550007': () => ({ all: true, other_party: '3135550007', contact: null, line_ids: [], messages: [], next_cursor: null }) }) });
    await openAll(env);
    const { doc, window, calls } = env;
    doc.getElementById('ph-new').click();
    expect(doc.getElementById('ph-new-from-row').hidden).toBe(false);
    const sel = doc.getElementById('ph-new-from-sel');
    expect([...sel.options].map((o) => o.value)).toEqual(['1', '4']);
    sel.value = '4';
    doc.getElementById('ph-new-to').value = '313-555-0007';
    doc.getElementById('ph-new-text').value = 'hello';
    doc.getElementById('ph-new-send').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/phone-lines/4/sms']);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/all/conversations/3135550007');
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    expect(calls.map((c) => c.url)).toContain('/api/phone-lines/all/calls');
    expect([...doc.querySelectorAll('#ph-list .msg')].map((r) => r.querySelector('.ln-tag').textContent)).toEqual(['Rena', 'Rena']);
  });

  test('no line to send from: no compose (with the reason), no New text; one line only: no All numbers, a remembered "all" falls back', async () => {
    const readOnly = ALL_LINES.map((l) => ({ ...l, can_send: false }));
    const env = await bootComms({ over: allOver({ 'GET /api/phone-lines/readable': () => ({ viewer: { su: false }, lines: fresh(readOnly) }) }) });
    await openAll(env);
    const { doc, window } = env;
    expect(doc.getElementById('ph-new').hidden).toBe(true);
    doc.querySelector('#ph-list .msg[data-party="3135550001"]').click();
    await tick(window, 60);
    expect(doc.getElementById('ph-compose').hidden).toBe(true);
    expect(doc.getElementById('ph-nosend').textContent).toMatch(/cannot send from any of your lines/);
    const one = [ALL_LINES[0]];
    const env2 = await bootComms({ over: allOver({ 'GET /api/phone-lines/readable': () => ({ viewer: { su: false }, lines: fresh(one) }) }), before: (w) => w.localStorage.setItem('yc-comms-phone-line', 'all') });
    await openPhone(env2);
    expect(env2.doc.querySelector('#ph-rail-lines .vitem[data-line="all"]')).toBeNull();
    expect([...env2.doc.getElementById('ph-line-sel').options].map((o) => o.value)).toEqual(['1']);
    expect(phoneCalls(env2.calls).map((c) => c.url)).toEqual(['/api/phone-lines/readable', '/api/phone-lines/1/conversations']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comms.html — Phone search (mailbox arc slice PS)
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_ROWS = [
  { ...CONVOS[0], matched_by: ['contact', 'case'], matched_cases: [{ case_id: 'C1', number: '24-41234', caption: `In re Pat ${EVIL}` }, { case_id: 'C2', number: '25-10001', caption: null }] },
];
// the search box's list reads answer by q; everything else as commsHandler
function searchOver(extra = {}) {
  const convos = (q) => (q && q.q
    ? { conversations: q.q === 'zzz' ? [] : fresh(SEARCH_ROWS), next_cursor: q.q === 'pat' && !q.cursor ? '13' : null, search: { q: q.q, too_short: false, capped: q.q === 'smith' ? ['contact'] : [] } }
    : { conversations: fresh(CONVOS), next_cursor: null });
  return {
    'GET /api/phone-lines/1/conversations': convos,
    'GET /api/phone-lines/3/conversations': convos,
    ...extra,
  };
}
// the pane debounces 250 ms; 450 leaves a loaded machine room
async function typeQ(env, value, wait = 450) {
  const box = env.doc.getElementById('ph-q');
  for (const v of [].concat(value)) {
    box.value = v;
    box.dispatchEvent(new env.window.Event('input'));
  }
  await tick(env.window, wait);
}
function searchEvents(env) {
  const seen = [];
  env.doc.getElementById('phone').addEventListener('ph-search', (e) => seen.push(fresh(e.detail)));
  return seen;
}

describe('comms.html — Phone search', () => {
  test('the box: second row of the list bar (.brk), the #f-q look, and the empty S6 slot under the results, hidden', async () => {
    const env = await bootComms();
    await openPhone(env);
    const { doc } = env;
    const box = doc.getElementById('ph-q');
    expect(box.closest('section.list-col').getAttribute('aria-label')).toBe('Texts and calls');
    expect(box.type).toBe('search');
    expect(box.maxLength).toBe(100);
    expect(box.previousElementSibling.className).toBe('brk');
    expect(box.parentElement.className).toBe('bar');
    const slot = doc.getElementById('ph-search-transcripts');
    expect(slot.hidden).toBe(true);
    expect(slot.children).toHaveLength(0);
    expect(slot.previousElementSibling.id).toBe('ph-list');
  });

  test('typing searches (debounced, one read); rows say the case they were found through — as text; a clear restores at once; Esc too', async () => {
    const env = await bootComms({ over: searchOver() });
    await openPhone(env);
    const { doc, window, calls, errors } = env;
    const events = searchEvents(env);
    const lists = () => calls.filter((c) => c.url === '/api/phone-lines/1/conversations').map((c) => c.payload);
    expect(lists()).toEqual([null]);
    // keystrokes inside the debounce make ONE read
    await typeQ(env, ['p', 'pa', ' pat ']);
    expect(lists()).toEqual([null, { q: 'pat' }]);
    expect(events).toEqual([{ q: 'pat', lineId: 1 }]);
    expect(doc.getElementById('ph-status').textContent).toBe('1+ conversation matching “pat”');
    const row = doc.querySelector('#ph-list .msg');
    expect(row.querySelector('.ph-why').textContent).toBe(` Case 24-41234 · In re Pat ${EVIL} +1`);
    expect(row.querySelector('.ph-why img')).toBeNull();
    expect(window.top.__pwned).toBeUndefined();
    // Load more keeps q
    doc.getElementById('ph-more').click();
    await tick(window, 60);
    expect(lists().slice(-1)).toEqual([{ q: 'pat', cursor: '13' }]);
    // the same text again (spaces aside) reads nothing
    await typeQ(env, 'pat');
    expect(lists()).toHaveLength(3);
    // cleared: back at once, without waiting for the debounce
    await typeQ(env, '', 20);
    expect(lists().slice(-1)).toEqual([null]);
    expect(events.slice(-1)).toEqual([{ q: '', lineId: 1 }]);
    expect(doc.querySelectorAll('#ph-list .msg')).toHaveLength(2);
    expect(doc.querySelector('#ph-list .ph-why')).toBeNull();
    expect(doc.getElementById('ph-status').textContent).toBe('2 conversations');
    // Esc clears the box and the search
    await typeQ(env, 'pat');
    doc.getElementById('ph-q').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(window, 20);
    expect(doc.getElementById('ph-q').value).toBe('');
    expect(lists().slice(-1)).toEqual([null]);
    expect(events.slice(-2)).toEqual([{ q: 'pat', lineId: 1 }, { q: '', lineId: 1 }]);
    // one character is no search (and no event)
    const n = lists().length;
    await typeQ(env, 'p');
    expect(lists()).toHaveLength(n);
    expect(events).toHaveLength(4);
    expect(errors).toEqual([]);
  });

  test('a view switch keeps q (Texts, Calls) and fires no event; a line switch keeps q and fires one; no event for a line switch without a search', async () => {
    const env = await bootComms({ over: searchOver() });
    await openPhone(env);
    const { doc, window, calls } = env;
    const events = searchEvents(env);
    // a line switch with an empty box: no event
    const sel = doc.getElementById('ph-line-sel');
    sel.value = '3';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 60);
    expect(events).toEqual([]);
    sel.value = '1';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 60);
    await typeQ(env, 'pat');
    expect(events).toEqual([{ q: 'pat', lineId: 1 }]);
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    doc.getElementById('ph-v-sms').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/phone-lines/1/calls').map((c) => c.payload)).toEqual([{ q: 'pat' }]);
    expect(calls.filter((c) => c.url === '/api/phone-lines/1/conversations').map((c) => c.payload).slice(-1)).toEqual([{ kind: 'sms', q: 'pat' }]);
    expect(events).toHaveLength(1);
    sel.value = '3';
    sel.dispatchEvent(new window.Event('change'));
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/phone-lines/3/conversations').map((c) => c.payload).slice(-1)).toEqual([{ kind: 'sms', q: 'pat' }]);
    expect(events).toEqual([{ q: 'pat', lineId: 1 }, { q: 'pat', lineId: 3 }]);
    expect(doc.getElementById('ph-q').value).toBe('pat');
  });

  test('All numbers: q rides the merged lists; the event names lineId "all"', async () => {
    const env = await bootComms({ over: allOver() });
    await openPhone(env);
    const { doc, window, calls } = env;
    const events = searchEvents(env);
    await typeQ(env, '2603');
    doc.querySelector('#ph-rail-lines .vitem[data-line="all"]').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/phone-lines/all/conversations').map((c) => c.payload)).toEqual([{ q: '2603' }]);
    expect(events).toEqual([{ q: '2603', lineId: 1 }, { q: '2603', lineId: 'all' }]);
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/phone-lines/all/calls').map((c) => c.payload)).toEqual([{ q: '2603' }]);
  });

  test('nothing found says what can be searched; a capped matcher is said in the status line', async () => {
    const env = await bootComms({ over: searchOver() });
    await openPhone(env);
    const { doc } = env;
    await typeQ(env, 'zzz');
    expect(doc.querySelector('#ph-list .empty').textContent)
      .toBe('No texts or calls on this line match “zzz” — search by a phone number (3+ digits), a contact\'s name, a case number, or a #reference number.');
    await typeQ(env, 'smith');
    expect(doc.getElementById('ph-status').textContent)
      .toBe('1 conversation matching “smith” — many names match; only the first 200 numbers each are searched, type more to narrow');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comms.html — Phone search by reference number ("#<id>", 2026-10-15)
// ─────────────────────────────────────────────────────────────────────────────

const REF = { id: 13, kind: 'sms', other_party: '3135550001', line_id: 1 };
const sms = (id, n = 0) => ({ id, kind: 'sms', direction: 'incoming', body: `text ${id}`, at: new Date(Date.parse('2026-10-08T00:00:00Z') + id * 60000 + n).toISOString(), logged: false });
/**
 * The ref search's fixtures: '#13' (and bare '13') find P1 with search.ref;
 * P1's thread is `pages` (newest first): page 0 is the newest page, page k
 * the answer to cursor `p<k>`; the last page has no next_cursor.
 */
function refOver(pages, extra = {}) {
  const convos = (q) => {
    if (!q || !q.q) return { conversations: fresh(CONVOS), next_cursor: null };
    const ref = ['#13', '13'].includes(q.q);
    return {
      conversations: ref ? [{ ...fresh(CONVOS[0]), matched_by: ['ref'] }, { ...fresh(CONVOS[1]), matched_by: ['contact'] }] : [{ ...fresh(CONVOS[1]), matched_by: ['contact'] }],
      next_cursor: null,
      search: { q: q.q, too_short: false, capped: [], ...(ref ? { ref: { ...REF } } : {}) },
    };
  };
  const thread = (q) => {
    const k = q && q.cursor ? Number(String(q.cursor).slice(1)) : 0;
    return { other_party: '3135550001', contact: { contact_id: 501, name: 'Pat One' }, messages: fresh(pages[k]), next_cursor: k + 1 < pages.length ? `p${k + 1}` : null };
  };
  return {
    'GET /api/phone-lines/1/conversations': convos,
    'GET /api/phone-lines/1/conversations/3135550001': thread,
    'GET /api/phone-lines/1/conversations/22395': () => ({ other_party: '22395', contact: null, messages: [sms(9)], next_cursor: null }),
    ...extra,
  };
}
/** Boot with the ref fixtures; body.scrollTo recorded; the ring held `hitMs`. */
async function bootRef(pages, { reduced = false, extra, hitMs = 1500 } = {}) {
  const scrolls = [];
  const env = await bootComms({
    over: refOver(pages, extra),
    before: (w) => {
      if (reduced) w.matchMedia = (m) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(m), media: m, addEventListener() {}, removeEventListener() {} });
    },
  });
  env.window.PH_HIT_MS = hitMs; // after boot: the page's own `var` would overwrite it
  await openPhone(env);
  env.doc.getElementById('ph-body').scrollTo = (o) => scrolls.push(fresh(o));
  return { ...env, scrolls };
}
const threadReads = (calls) => calls.filter((c) => c.url === '/api/phone-lines/1/conversations/3135550001').map((c) => c.payload);
const hits = (doc) => [...doc.querySelectorAll('#ph-body .bub.ph-hit')].map((b) => Number(b.dataset.id));
const jumpNote = (doc) => { const n = doc.querySelector('#ph-body .ph-jump-note'); return n ? n.textContent : null; };

describe('comms.html — Phone search by reference number', () => {
  test('the box says it takes a #ref; a ref row says so; opening it rings that bubble, centred, smoothly — briefly', async () => {
    const env = await bootRef([[sms(2), sms(13), sms(14)]], { hitMs: 300 });
    const { doc, window, scrolls, errors } = env;
    expect(doc.getElementById('ph-q').placeholder).toBe('Number, name, case number or #ref');
    expect(doc.getElementById('ph-q').getAttribute('aria-label')).toMatch(/#reference number/);
    await typeQ(env, '#13');
    const rows = [...doc.querySelectorAll('#ph-list .msg')];
    expect(rows.map((r) => r.querySelector('.ph-why') && r.querySelector('.ph-why').textContent)).toEqual([' Reference #13', null]);
    rows[0].click();
    await tick(window, 40);
    expect(hits(doc)).toEqual([13]);
    expect(scrolls).toEqual([{ top: 0, behavior: 'smooth' }]);
    expect(threadReads(env.calls)).toEqual([null]); // found on the newest page: no paging
    await tick(window, 400);
    expect(hits(doc)).toEqual([]); // the ring is brief
    expect(errors).toEqual([]);
  });

  test('a row the ref did not find opens without a ring; a non-ref search never rings', async () => {
    const env = await bootRef([[sms(2), sms(13)]]);
    const { doc, window, scrolls } = env;
    await typeQ(env, '#13');
    doc.querySelectorAll('#ph-list .msg')[1].click(); // 22395, found by its contact
    await tick(window, 40);
    expect([hits(doc), scrolls, jumpNote(doc)]).toEqual([[], [], null]); // no jump at all — not even a failed one
    await typeQ(env, 'pat');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 40);
    expect([hits(doc), scrolls]).toEqual([[], []]);
  });

  test('not on the loaded page: earlier pages load, one at a time, until the bubble shows — then the ring', async () => {
    const env = await bootRef([[sms(40), sms(41)], [sms(30), sms(31)], [sms(20), sms(21)], [sms(12), sms(13)], [sms(1)]]);
    const { doc, window, errors } = env;
    await typeQ(env, '#13');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 150);
    expect(threadReads(env.calls)).toEqual([null, { cursor: 'p1' }, { cursor: 'p2' }, { cursor: 'p3' }]);
    expect(hits(doc)).toEqual([13]);
    expect([...doc.querySelectorAll('#ph-body .bub')].map((b) => Number(b.dataset.id))).toEqual([12, 13, 20, 21, 30, 31, 40, 41]);
    expect(doc.getElementById('ph-older')).not.toBeNull(); // page 4 is still there to load
    expect(jumpNote(doc)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('the cap: PH_JUMP_PAGES earlier pages, then a muted note; Load earlier keeps looking and rings it when it shows', async () => {
    const pages = Array.from({ length: 13 }, (_, k) => [sms(500 - k * 2), sms(501 - k * 2)]);
    pages[11] = [sms(13), sms(14)];
    const env = await bootRef(pages);
    const { doc, window } = env;
    await typeQ(env, '#13');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 300);
    const reads = threadReads(env.calls);
    expect(reads).toHaveLength(11); // the newest page + 10 earlier
    expect(reads.slice(-1)).toEqual([{ cursor: 'p10' }]);
    expect(hits(doc)).toEqual([]);
    expect(jumpNote(doc)).toBe('#13 is further back than 10 earlier pages — Load earlier to keep looking.');
    expect(doc.querySelector('#ph-body .ph-jump-note').getAttribute('style')).toBeNull();
    doc.getElementById('ph-older').click();
    await tick(window, 60);
    expect(threadReads(env.calls).slice(-1)).toEqual([{ cursor: 'p11' }]);
    expect(hits(doc)).toEqual([13]);
    expect(jumpNote(doc)).toBeNull();
  });

  test('nothing earlier and no bubble: the note says it is not in this conversation', async () => {
    const env = await bootRef([[sms(2), sms(14)]]);
    const { doc, window } = env;
    await typeQ(env, '#13');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 60);
    expect([hits(doc), jumpNote(doc)]).toEqual([[], '#13 is not in this conversation.']);
    // another conversation drops the note and the jump
    doc.querySelectorAll('#ph-list .msg')[1].click();
    await tick(window, 60);
    expect(jumpNote(doc)).toBeNull();
  });

  test('reduced motion: the jump is instant and the ring does not pulse', async () => {
    const env = await bootRef([[sms(2), sms(13)]], { reduced: true });
    const { doc, window, scrolls } = env;
    await typeQ(env, '#13');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 40);
    expect(hits(doc)).toEqual([13]);
    expect(scrolls).toEqual([{ top: 0, behavior: 'auto' }]);
    // the stylesheet: the ring animates, and reduced motion takes the animation away
    expect(COMMS).toMatch(/\.bub\.ph-hit \{[^}]*animation: ph-hit/);
    expect(COMMS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.bub\.ph-hit \{ animation: none; \} \}/);
  });

  test('Enter in the box opens the ref\'s conversation at its bubble — after the search answers, even mid-debounce; Enter on other text opens nothing', async () => {
    const env = await bootRef([[sms(2), sms(13)]]);
    const { doc, window } = env;
    const box = doc.getElementById('ph-q');
    box.value = '#13';
    box.dispatchEvent(new window.Event('input'));
    box.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(window, 80);
    expect(env.calls.filter((c) => c.url === '/api/phone-lines/1/conversations').map((c) => c.payload)).toEqual([null, { q: '#13' }]);
    expect(hits(doc)).toEqual([13]);
    expect(doc.getElementById('phone').classList.contains('show-thread')).toBe(true);
    await tick(window, 400); // the debounce that Enter overtook reads nothing more
    expect(env.calls.filter((c) => c.url === '/api/phone-lines/1/conversations')).toHaveLength(2);
    // typing alone never opens: a fresh pane, '#13' typed and left
    const env2 = await bootRef([[sms(2), sms(13)]]);
    await typeQ(env2, '#13');
    expect([threadReads(env2.calls), env2.doc.getElementById('phone').classList.contains('show-thread')]).toEqual([[], false]);
    await typeQ(env2, 'pat');
    env2.doc.getElementById('ph-q').dispatchEvent(new env2.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(env2.window, 60);
    expect(threadReads(env2.calls)).toEqual([]);
  });

  test('Enter after a failed search asks again (and opens on the answer); a keystroke after Enter cancels the open', async () => {
    let fail = 1;
    const base = refOver([[sms(2), sms(13)]])['GET /api/phone-lines/1/conversations'];
    const flaky = (q) => { if (q && q.q === '#13' && fail-- > 0) throw new Error('down'); return base(q); };
    const env = await bootRef([[sms(2), sms(13)]], { extra: { 'GET /api/phone-lines/1/conversations': flaky } });
    const { doc, window } = env;
    const lists = () => env.calls.filter((c) => c.url === '/api/phone-lines/1/conversations').map((c) => c.payload);
    const enter = () => doc.getElementById('ph-q').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await typeQ(env, '#13');
    expect(doc.getElementById('ph-error').textContent).toMatch(/down/);
    enter();
    await tick(window, 80);
    expect(lists()).toEqual([null, { q: '#13' }, { q: '#13' }]);
    expect(hits(doc)).toEqual([13]);
    // a slow answer: Enter, then another keystroke before it lands — the answer opens nothing
    const slow = (q) => new Promise((r) => window.setTimeout(() => r(base(q)), 150));
    const env2 = await bootRef([[sms(2), sms(13)]], { extra: { 'GET /api/phone-lines/1/conversations': (q) => (q && q.q ? slow(q) : base(q)) } });
    const box = env2.doc.getElementById('ph-q');
    box.value = '#13';
    box.dispatchEvent(new env2.window.Event('input'));
    box.dispatchEvent(new env2.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(env2.window, 30);
    box.value = '#13 ';
    box.dispatchEvent(new env2.window.Event('input')); // same q once trimmed: no new read, only the keystroke
    await tick(env2.window, 500);
    expect([threadReads(env2.calls), env2.doc.getElementById('phone').classList.contains('show-thread')]).toEqual([[], false]);
  });

  test('a jump stops when the search changes, and a conversation reopened any other way does not resume it', async () => {
    const pages = Array.from({ length: 13 }, (_, k) => [sms(500 - k * 2), sms(501 - k * 2)]);
    const base = refOver(pages)['GET /api/phone-lines/1/conversations/3135550001'];
    const slowThread = (q) => new Promise((r) => setTimeout(() => r(base(q)), 60));
    const env = await bootRef(pages, { extra: { 'GET /api/phone-lines/1/conversations/3135550001': slowThread } });
    const { doc, window } = env;
    await typeQ(env, '#13');
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 100);
    await typeQ(env, '#13 99', 300); // a new search mid-jump
    const n = threadReads(env.calls).length;
    await tick(window, 900);
    expect(threadReads(env.calls)).toHaveLength(n);
    expect(n).toBeLessThan(11);
    expect(jumpNote(doc)).toBeNull();
    // paused at the cap (the note up), then the same conversation re-read by Refresh: the jump is gone, the note too
    const env2 = await bootRef(pages);
    await typeQ(env2, '#13');
    env2.doc.querySelector('#ph-list .msg').click();
    await tick(env2.window, 300);
    expect(jumpNote(env2.doc)).toMatch(/further back than 10 earlier pages/);
    env2.doc.getElementById('ph-refresh').click();
    await tick(env2.window, 80);
    expect([jumpNote(env2.doc), hits(env2.doc)]).toEqual([null, []]);
    env2.doc.getElementById('ph-older').click(); // a plain Load earlier now: no ring when #13's page arrives
    await tick(env2.window, 60);
    expect(hits(env2.doc)).toEqual([]);
  });

  test('a ref whose id is not a whole number is ignored (it never reaches a selector): no note, no jump', async () => {
    const odd = (q) => ({ conversations: [{ ...fresh(CONVOS[0]), matched_by: ['ref'] }], next_cursor: null, search: { q: q.q, too_short: false, capped: [], ref: { ...REF, id: '13"]' } } });
    const env = await bootRef([[sms(2), sms(13)]], { extra: { 'GET /api/phone-lines/1/conversations': (q) => (q && q.q ? odd(q) : { conversations: fresh(CONVOS), next_cursor: null }) } });
    const { doc, window, errors } = env;
    await typeQ(env, '#13');
    expect(doc.querySelector('#ph-list .ph-why')).toBeNull();
    doc.querySelector('#ph-list .msg').click();
    await tick(window, 60);
    expect([hits(doc), jumpNote(doc), errors]).toEqual([[], null, []]);
  });

  test('Calls: the ref\'s call row opens the conversation at that call; another call with the number does not ring', async () => {
    const CALL_REF = { id: 10, kind: 'call', other_party: '3135550001', line_id: 1 };
    const callsQ = (q) => ({
      calls: q && q.q ? [{ ...fresh(CALLS.calls[0]), matched_by: ['ref'] }, { ...fresh(CALLS.calls[0]), id: 8, matched_by: ['number'] }] : fresh(CALLS.calls),
      next_cursor: null,
      ...(q && q.q ? { search: { q: q.q, too_short: false, capped: [], ref: CALL_REF } } : {}),
    });
    const call = (id) => ({ id, kind: 'call', direction: 'incoming', at: new Date(Date.parse('2026-10-08T00:00:00Z') + id * 60000).toISOString(), logged: false, duration_s: 30, status: 'no-answer', unanswered: true, missed: true });
    const env = await bootRef([[call(8), sms(9), call(10)]], { extra: { 'GET /api/phone-lines/1/calls': callsQ } });
    const { doc, window } = env;
    doc.getElementById('ph-v-calls').click();
    await tick(window, 60);
    await typeQ(env, '#10');
    const rows = [...doc.querySelectorAll('#ph-list .msg')];
    expect(rows.map((r) => r.dataset.call)).toEqual(['10', '8']);
    rows[1].click();
    await tick(window, 40);
    expect(hits(doc)).toEqual([]);
    rows[0].click();
    await tick(window, 40);
    expect(hits(doc)).toEqual([10]);
    expect(doc.querySelector('#ph-body .bub.ph-hit').classList.contains('call')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// connections.html — Phone Lines → Access
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_LINES = [
  { id: 1, phone_number: '2485592400', display_name: 'Stuart', provider: 'ringcentral', provider_id: null, credential_id: 1, active: 1, mms_capable: 1, credential_name: 'RC', credential_type: 'oauth2' },
  { id: 3, phone_number: '2489655355', display_name: 'Rena', provider: 'quo', provider_id: 'PN3', credential_id: 2, active: 1, mms_capable: 0, credential_name: 'Quo', credential_type: 'api_key' },
];

function connHandler(state) {
  return (url, method, payload) => {
    if (url === '/api/credentials') return { credentials: [] };
    if (url === '/api/email-credentials') return { email_credentials: [] };
    if (url === '/api/phone-lines/admin') return { phone_lines: fresh(ADMIN_LINES), providers: {} };
    if (url === '/api/users') return { users: [{ user: 0, username: 'automations' }, { user: 22, user_name: 'Rena', user_auth: 'authorized' }, { user: 9, user_name: 'Nobody', user_auth: 'authorized' }, { user: 4, user_name: 'Gone', user_auth: 'disabled' }] };
    let m;
    if ((m = /^\/api\/phone-lines\/(\d+)\/grants$/.exec(url)) && method === 'GET') return { grants: fresh(state.grants) };
    if ((m = /^\/api\/phone-lines\/(\d+)\/grants$/.exec(url)) && method === 'POST') {
      const g = { id: 100 + state.grants.length, user: payload.user, user_name: payload.user === 9 ? 'Nobody' : 'x', channel_type: 'phone_line', channel_id: Number(m[1]), can_read: payload.can_read, can_send: payload.can_send, can_manage: payload.can_manage, granted_by: 6, granted_by_username: 'IT' };
      state.grants.push(g);
      return { grant: g };
    }
    if ((m = /^\/api\/phone-lines\/\d+\/grants\/(\d+)$/.exec(url)) && method === 'PATCH') {
      const g = state.grants.find((x) => x.id === Number(m[1]));
      Object.assign(g, payload);
      return { grant: fresh(g) };
    }
    if ((m = /^\/api\/phone-lines\/\d+\/grants\/(\d+)$/.exec(url)) && method === 'DELETE') {
      state.grants = state.grants.filter((x) => x.id !== Number(m[1]));
      return { status: 'success' };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

describe('connections.html — phone line Access editor', () => {
  test('Access → users + grants; tick PATCHes one flag; Add POSTs; Remove DELETEs; the list is the server\'s', async () => {
    const state = { grants: [{ id: 50, user: 22, user_name: 'Rena', user_auth: 'authorized', channel_type: 'phone_line', channel_id: 3, can_read: true, can_send: true, can_manage: false, granted_by: 6, granted_by_username: 'IT' }] };
    const env = await bootPage({ url: 'https://app.4lsg.com/connections.html', html: CONN, libs: [], handler: connHandler(state) });
    const { doc, window, calls, errors } = env;
    expect(errors).toEqual([]);
    doc.querySelector('tr[data-id="3"] button[data-action="access"]').click();
    await tick(window, 60);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(expect.arrayContaining(['GET /api/users', 'GET /api/phone-lines/3/grants']));
    expect(doc.getElementById('phone-grants-title').textContent).toMatch(/Access — Rena/);
    const rows = [...doc.querySelectorAll('#phone-grants-tbody tr')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toMatch(/Rena/);
    // the Add picker: users > 0, not disabled, not already granted
    expect([...doc.getElementById('phone-gr-user').options].map((o) => o.value)).toEqual(['9']);

    const manage = doc.querySelector('#phone-grants-tbody input[data-flag="can_manage"]');
    manage.checked = true;
    manage.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window, 40);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.payload])).toEqual([['/api/phone-lines/3/grants/50', { can_manage: true }]]);

    // unticking the last flag is refused client-side (a grant keeps one) — no call
    const r = doc.querySelector('#phone-grants-tbody input[data-flag="can_read"]');
    const s = doc.querySelector('#phone-grants-tbody input[data-flag="can_send"]');
    const m2 = doc.querySelector('#phone-grants-tbody input[data-flag="can_manage"]');
    for (const box of [r, s]) { box.checked = false; box.dispatchEvent(new window.Event('change', { bubbles: true })); await tick(window, 30); }
    m2.checked = false;
    m2.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window, 30);
    expect(m2.checked).toBe(true);
    expect(doc.getElementById('phone-grants-msg').textContent).toMatch(/at least one/);

    doc.getElementById('phone-gr-send').checked = true;
    doc.getElementById('phone-gr-add').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.payload]))
      .toEqual([['/api/phone-lines/3/grants', { user: 9, can_read: true, can_send: true, can_manage: false }]]);
    expect(doc.querySelectorAll('#phone-grants-tbody tr')).toHaveLength(2);

    doc.querySelector('#phone-grants-tbody button[data-rm="50"]').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/phone-lines/3/grants/50']);
    expect([...doc.querySelectorAll('#phone-grants-tbody tr')].map((tr) => tr.textContent)).toEqual([expect.stringMatching(/Nobody/)]);
  });

  test('the editor survives a list refresh and Close removes it', async () => {
    const state = { grants: [] };
    const env = await bootPage({ url: 'https://app.4lsg.com/connections.html', html: CONN, libs: [], handler: connHandler(state) });
    const { doc, window } = env;
    doc.querySelector('tr[data-id="1"] button[data-action="access"]').click();
    await tick(window, 60);
    expect(doc.getElementById('phone-grants-tbody').textContent).toMatch(/No grants/);
    await window.eval('loadPhone()');
    await tick(window, 40);
    expect(doc.getElementById('phone-grants')).not.toBeNull();
    doc.getElementById('phone-grants-close').click();
    expect(doc.getElementById('phone-grants')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// public/js/phoneSendable.js — the From-picker filter
// ─────────────────────────────────────────────────────────────────────────────

function selectDom(values, selected) {
  const dom = new JSDOM('<!DOCTYPE html><select id="s"></select>', { runScripts: 'dangerously' });
  DOMS.push(dom);
  const { window } = dom;
  const sel = window.document.getElementById('s');
  for (const v of values) { const o = window.document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }
  sel.value = selected;
  const sc = window.document.createElement('script');
  sc.textContent = SENDABLE;
  window.document.body.appendChild(sc);
  const changes = [];
  sel.addEventListener('change', () => changes.push(sel.value));
  return { window, sel, changes };
}

describe('phoneSendable.filterSelect', () => {
  const api = (lines) => async (url) => { expect(url).toBe('/api/phone-lines/sendable'); return { lines }; };

  test('removes lines the user cannot send from; keeps a surviving selection; no change event', async () => {
    const { window, sel, changes } = selectDom(['2485592400', '2489655355', '2484179800'], '2489655355');
    const out = await window.YCPhoneSendable.filterSelect(sel, api([{ phone_number: '2489655355' }, { phone_number: '2484179800' }]));
    expect(out).toEqual({ filtered: true, sendable: 2 });
    expect([...sel.options].map((o) => o.value)).toEqual(['2489655355', '2484179800']);
    expect(sel.value).toBe('2489655355');
    expect(changes).toEqual([]);
  });

  test('a removed selection moves to the preferred line (else the first) and fires change', async () => {
    let t = selectDom(['2485592400', '2489655355', '2484179800'], '2485592400');
    await t.window.YCPhoneSendable.filterSelect(t.sel, api([{ phone_number: '2489655355' }, { phone_number: '2484179800' }]), { preferred: '2484179800' });
    expect([t.sel.value, t.changes]).toEqual(['2484179800', ['2484179800']]);
    t = selectDom(['2485592400', '2489655355', '2484179800'], '2485592400');
    await t.window.YCPhoneSendable.filterSelect(t.sel, api([{ phone_number: '2489655355' }, { phone_number: '2484179800' }]), { preferred: '2485592400' });
    expect(t.sel.value).toBe('2489655355');
  });

  test('nothing sendable → one disabled placeholder; a failed fetch leaves the select alone', async () => {
    let t = selectDom(['2485592400'], '2485592400');
    await t.window.YCPhoneSendable.filterSelect(t.sel, api([]));
    expect(t.sel.disabled).toBe(true);
    expect([...t.sel.options].map((o) => [o.value, o.textContent])).toEqual([['', expect.stringMatching(/No line you can text from/)]]);
    t = selectDom(['2485592400', '2489655355'], '2485592400');
    const out = await t.window.YCPhoneSendable.filterSelect(t.sel, async () => { throw new Error('404'); });
    expect(out).toEqual({ filtered: false, sendable: null });
    expect([...t.sel.options]).toHaveLength(2);
  });

  test('the three staff SMS pickers load the helper and run it on their SMS From select', () => {
    for (const [file, sel] of [['public/communicate.html', 'smsSel'], ['public/sendingform.html', "document.getElementById('smsFrom')"], ['public/sendingform-bk.html', "document.getElementById('smsFrom')"]]) {
      const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect([file, html.includes('<script src="/js/phoneSendable.js"></script>')]).toEqual([file, true]);
      expect([file, html.includes(`YCPhoneSendable.filterSelect(${sel}, P.apiSend, { preferred: currentUser.default_phone })`)]).toEqual([file, true]);
    }
  });
});
