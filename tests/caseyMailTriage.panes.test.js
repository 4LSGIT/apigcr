/**
 * @jest-environment node
 *
 * tests/caseyMailTriage.panes.test.js — A13's two bus READERS: the comms hub
 * (public/comms.html) and a case's / contact's Comms tab
 * (public/entityCommunications.html) hear the one-message mail writes that
 * public/js/yc-sync.js now announces (tests/ycSync.test.js pins the matchers):
 *
 *   hub  `mail:<id>` {unread}: the list row and the open card repaint from the
 *        value — no GET; a merged row stays unread while ANY copy is; the
 *        counts refresh. `mail:<id>` {log_id, case_id}: a listed row re-reads
 *        the list quietly; the open card's log line names the case; a row or
 *        card already on that case (the pane's own write) is skipped.
 *   tab  `comms:case:<id>` re-reads a case tab's feed; `mail:<id>` {case_id}
 *        re-reads a tab showing that message under another case; parked while
 *        hidden, refreshed on return; a feed already showing the case skips.
 *
 * JSDOM loads no <script src>: yc-sync.js is evaluated by hand, like the
 * other helpers (tests/mailboxS2P.pane.test.js, tests/entityCommunications.widget.test.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SYNC = read('public/js/yc-sync.js');
const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));
// JSDOM has no BroadcastChannel; a single window only needs local dispatch.
const quietChannel = (w) => { w.BroadcastChannel = class { postMessage() {} close() {} }; };

test('both readers load the bus script', () => {
  expect(read('public/comms.html')).toContain('<script src="/js/yc-sync.js"></script>');
  expect(read('public/entityCommunications.html')).toContain('<script src="/js/yc-sync.js"></script>');
});

// ── The hub ────────────────────────────────────────────────────────────────
const HTML = read('public/comms.html');
const HELPERS = ['public/js/vendor/purify-3.4.16.min.js', 'public/js/mailRender.js', 'public/js/mailboxColor.js', 'public/js/optoutAck.js'].map(read);
const MB = [{ id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 2,
  sync: { checked_at: new Date().toISOString(), stale: false, failing: false } }];
const ROW = (over = {}) => ({
  id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null,
  message_id: 'root@x.test', thread_key: 'root@x.test', from_addr: 'Jane Doe <jane@client.test>', to_addrs: 'billing@firm.test',
  cc_addrs: null, subject: 'Plan objection', date: '2026-10-08T14:00:00.000Z', snippet: 'snip', unread: true,
  attachment_count: 0, log_id: null, log_status: { state: 'store_only' }, case: null,
  copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', place: null, unread: true }],
  ...over,
});

async function bootHub(rows) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  quietChannel(window);
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user: 2, user_name: 'Rena R' }, users: [{ user: 2, user_name: 'Rena R' }] };
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null) => {
    calls.push({ url, method });
    if (url === '/api/mail/mailboxes') return { mailboxes: fresh(MB), viewer: { su: false, role: null, can_send: true }, inbox_unread_distinct: 1 };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: fresh(rows), next_cursor: null };
    if (url === '/api/mail/threads/root%40x.test') return { thread_key: 'root@x.test', subject: 'Plan objection', truncated: false, messages: [{ ...fresh(rows[0]), unread: false, copies: fresh(rows[0].copies).map((c) => ({ ...c, unread: false })), body_text: 'b', body_html: null, attachments: [], from_email: 'jane@client.test', images_trusted: false }] };
    if (url === '/api/mail/read' && method === 'POST') return { marked: (payload && payload.ids ? payload.ids.length : 0) };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [], unmatched: [] };
    if (url === '/api/comms-archive/admin') return { archive_admin: false };
    return {};
  };
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  window.document.body.innerHTML = ((noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '').replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  for (const src of [...HELPERS, SYNC, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors };
}
const rowEl = (doc, id) => doc.querySelector(`#msg-list .msg[data-id="${id}"]`);
const gets = (calls, url) => calls.filter((c) => c.url === url && c.method === 'GET').length;

describe('the comms hub hears mail:<id>', () => {
  test('{unread}: the row repaints from the value with no list GET; the counts refresh', async () => {
    const { window, doc, calls, errors } = await bootHub([ROW()]);
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(true);
    const lists = gets(calls, '/api/mail/messages'); const summaries = gets(calls, '/api/mail/mailboxes');
    window.YC.emit('mail:11', { unread: false }, 'test');
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(false);
    await tick(window, 500);
    expect(gets(calls, '/api/mail/messages')).toBe(lists);
    expect(gets(calls, '/api/mail/mailboxes')).toBe(summaries + 1);
    window.YC.emit('mail:11', { unread: true }, 'test');
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('{unread}: a merged row stays unread while ANY copy is; a message not listed is ignored', async () => {
    const copies = [{ id: 11, mailbox_id: 1, folder: 'INBOX', unread: true }, { id: 12, mailbox_id: 1, folder: 'Archive', unread: true }];
    const { window, doc } = await bootHub([ROW({ copies })]);
    window.YC.emit('mail:12', { unread: false }, 'test');
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(true);
    window.YC.emit('mail:11', { unread: false }, 'test');
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(false);
    window.YC.emit('mail:999', { unread: true }, 'test');
    expect(rowEl(doc, 11).classList.contains('unread')).toBe(false);
  });

  test('{log_id, case_id}: a listed row re-reads the list quietly; a row already on that case does not', async () => {
    const { window, calls } = await bootHub([ROW()]);
    const before = gets(calls, '/api/mail/messages');
    window.YC.emit('mail:11', { log_id: 5, case_id: 'AAAA' }, 'test');
    await tick(window, 350);
    expect(gets(calls, '/api/mail/messages')).toBe(before + 1);
    const on = await bootHub([ROW({ log_status: { state: 'case', case: { case_id: 'AAAA', case_number: '25-1' }, log_id: 5, via: 'stamped' }, case: { case_id: 'AAAA', case_number: '25-1' } })]);
    const b2 = gets(on.calls, '/api/mail/messages');
    on.window.YC.emit('mail:11', { log_id: 5, case_id: 'aaaa' }, 'test');
    await tick(on.window, 350);
    expect(gets(on.calls, '/api/mail/messages')).toBe(b2);
  });

  test('{log_id, case_id}: the open conversation\'s log line names the case', async () => {
    const { window, doc } = await bootHub([ROW()]);
    rowEl(doc, 11).click();
    await tick(window, 120);
    expect(doc.querySelector('.mcard .logline').textContent).toMatch(/Not on the log/);
    window.YC.emit('mail:11', { log_id: 5, case_id: 'AAAA' }, 'test');
    expect(doc.querySelector('.mcard .logline').textContent).toMatch(/On the log of.*AAAA.*Change/s);
  });
});

// ── The Comms tab ──────────────────────────────────────────────────────────
const TAB = read('public/entityCommunications.html');
const OPTOUT = read('public/js/optoutAck.js');

function bootTab({ type = 'case', id = 'AAAA', items = [] } = {}) {
  const apiSend = jest.fn(async (url) => {
    if (/\/contacts$/.test(url)) return { contacts: [] };
    return { items: fresh(items), next_offset: null, has_more: false };
  });
  const dom = new JSDOM(TAB, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: `https://example.test/entityCommunications.html?link_type=${type}&link_id=${id}`,
    beforeParse(window) {
      window.eval(OPTOUT);
      quietChannel(window);
      window.eval(SYNC);
      window.apiSend = apiSend;
      window.firmData = { id: 1 };
      window.entityData = {};
    },
  });
  DOMS.push(dom);
  const feeds = () => apiSend.mock.calls.filter((c) => /\/communications$/.test(c[0])).length;
  return { dom, window: dom.window, apiSend, feeds };
}
const MAILITEM = (over = {}) => ({ key: 'mail:41', id: 41, kind: 'email', direction: 'incoming', at: '2026-10-19T10:00:00Z', participant: 'jane@client.test',
  preview: 'p', email: { id: 41, mailbox_id: 1 }, case_id: null, log_id: null, ...over });

describe('the Comms tab hears comms:case:<id> and mail:<id>', () => {
  test('a case tab re-reads its feed on its own comms:case address — not another case\'s', async () => {
    const t = bootTab();
    await tick(t.window, 30);
    const n = t.feeds();
    t.window.YC.emit('comms:case:OTHER', { yc_refetch: 1 }, 'test');
    await tick(t.window, 350);
    expect(t.feeds()).toBe(n);
    t.window.YC.emit('comms:case:AAAA', { yc_refetch: 1 }, 'test');
    await tick(t.window, 350);
    expect(t.feeds()).toBe(n + 1);
  });

  test('parked while hidden, refreshed on return', async () => {
    const t = bootTab();
    await tick(t.window, 30);
    const n = t.feeds();
    Object.defineProperty(t.window.document, 'hidden', { value: true, configurable: true });
    t.window.YC.emit('comms:case:AAAA', { yc_refetch: 1 }, 'test');
    await tick(t.window, 350);
    expect(t.feeds()).toBe(n);
    Object.defineProperty(t.window.document, 'hidden', { value: false, configurable: true });
    t.window.document.dispatchEvent(new t.window.Event('visibilitychange'));
    await tick(t.window, 30);
    expect(t.feeds()).toBe(n + 1);
  });

  test('a contact tab re-reads when a message it shows moves onto a case it does not show; not for its own tag or another message', async () => {
    const t = bootTab({ type: 'contact', id: '42', items: [MAILITEM()] });
    await tick(t.window, 30);
    const n = t.feeds();
    t.window.YC.emit('mail:99', { log_id: 7, case_id: 'AAAA' }, 'test');
    await tick(t.window, 350);
    expect(t.feeds()).toBe(n);
    t.window.YC.emit('mail:41', { log_id: 7, case_id: 'AAAA' }, 'test');
    await tick(t.window, 350);
    expect(t.feeds()).toBe(n + 1);
    const own = bootTab({ type: 'contact', id: '42', items: [MAILITEM({ case_id: 'AAAA' })] });
    await tick(own.window, 30);
    const m = own.feeds();
    own.window.YC.emit('mail:41', { log_id: 7, case_id: 'aaaa' }, 'test');
    await tick(own.window, 350);
    expect(own.feeds()).toBe(m);
  });
});
