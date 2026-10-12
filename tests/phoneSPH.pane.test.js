/**
 * @jest-environment node
 *
 * tests/phoneSPH.pane.test.js — the S-PH front end, booted in jsdom against a
 * stub shell apiSend (the tests/mailboxS2.pane.test.js harness; in jsdom a
 * top-level window is its own parent, so window.apiSend IS the pane's
 * P.apiSend):
 *   - public/comms.html Phone tab: lazy boot on first open, the lines rail +
 *     picker, Texts / Calls, a conversation as TEXT bubbles with its calls
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
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user_auth: 'authorized - SU' } };
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
  test('lazy: nothing phone-shaped until the tab opens; then readable → rail + picker → Texts of the first ACTIVE line', async () => {
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
    expect(rail.map((b) => b.dataset.line)).toEqual(['1', '3', '7']);
    expect(rail[0].getAttribute('aria-current')).toBe('true');
    expect(rail[0].querySelector('.acc').textContent).toBe('R·S');
    expect(rail[1].querySelector('.acc').textContent).toBe('R');
    expect(rail[2].querySelector('.sub').textContent).toBe('(248) 000-0007 · inactive');
    expect([...doc.getElementById('ph-line-sel').options].map((o) => o.value)).toEqual(['1', '3', '7']);
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
    expect(doc.getElementById('ph-v-calls').disabled).toBe(true);
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
