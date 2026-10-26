/**
 * @jest-environment node
 *
 * tests/mailboxS2P.pane.test.js — the Comms polish slice's pane surface
 * (public/comms.html), on top of tests/mailboxS2.pane.test.js's harness:
 *
 *   A.2  the log-status line under every card header — one line per state,
 *        carrying the case action (it replaced the chip + Link/Change row);
 *   B    merged list rows: a labelled chip per copy; a later page's copy of a
 *        shown email FOLDS into its row (never a second row);
 *   C    "Checked N min ago" + a warning chip per stale / failing box;
 *   D.1  the ⋯ menu: one open at a time, Escape closes it, real buttons;
 *   D.5  the search box's from: token ↔ from_domain; "Filters (n)";
 *   E    the Task modal: defaults, caps, the link chips, POST /api/tasks
 *        with source 'comms', the Open-tasks toast;
 *   F/G  "Sent by X via YisraCase" + "Linking to <case>…" on the line; the
 *        composer's Case field (reply default; suggestions never auto-pick;
 *        case_id rides the send body).
 *
 * Mutation-checked (S2P worker report):
 *   - logLine wording / the case action dropped per state      → the state-matrix test
 *   - the fold adding a second row / losing the copies         → the fold test
 *   - menu not closing on Escape / two menus at once           → menu tests
 *   - task title/desc caps not enforced client-side            → cap test
 *   - the Task POST missing source 'comms' / the link          → task tests
 *   - the Case suggestion auto-picking / case_id not sent      → composer tests
 *   - New message's picker offering the open thread's cases     → the picker-source test (hotfix 2026-10-13)
 *   - parseSearch keeping the from: token inside q             → from: tests
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');
const PURIFY = fs.readFileSync(path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');
const COLOR = fs.readFileSync(path.join(ROOT, 'public/js/mailboxColor.js'), 'utf8');
const OPTOUT = fs.readFileSync(path.join(ROOT, 'public/js/optoutAck.js'), 'utf8'); // the send path's opt-out confirm

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));

const MB = [
  { id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 2, sync: { checked_at: new Date(Date.now() - 3 * 60_000).toISOString(), stale: false, failing: false } },
  { id: 2, address: 'intake-with-a-long-name@firm.test', display_name: null, color: '#fff3bf', active: true, can_send: false, can_manage: false, inbox_total: 1, inbox_unread: 1, sync: { checked_at: '2026-10-11T07:25:05.737Z', stale: true, failing: true, error_at: '2026-10-12T00:00:00Z' } },
];
const ROW = (over = {}) => ({
  id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null,
  message_id: 'root@x.test', thread_key: 'root@x.test', from_addr: 'Jane Doe <jane@client.test>', to_addrs: 'billing@firm.test',
  cc_addrs: null, subject: 'Plan objection', date: '2026-10-08T14:00:00.000Z', snippet: 'snip', unread: false,
  attachment_count: 0, log_id: null, log_status: { state: 'store_only' },
  case: null, copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', place: null, unread: false }],
  ...over,
});
const TMSG = (over = {}) => ({
  ...ROW(), body_text: 'plain body', body_html: '<p>Hello</p>', attachments: [], from_email: 'jane@client.test', images_trusted: false,
  ...over,
});

async function boot({ handler, width = 1024 } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  window.firmData = {
    firmTimezone: 'America/Detroit',
    currentUser: { user: 2, user_name: 'Rena R' },
    users: [{ user: 1, user_name: 'Stuart S' }, { user: 2, user_name: 'Rena R' }, { user: 6, user_name: 'IT' }],
  };
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null, headers = {}, opts = {}) => {
    calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)), opts });
    return handler(url, method, payload, opts);
  };
  window.addFile = (...a) => calls.push({ addFile: a });
  const opened = [];
  window.openTasksTab = (...a) => opened.push(a);
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [PURIFY, RENDER, COLOR, OPTOUT, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors, opened };
}

function standard(over = {}) {
  return (url, method, payload) => {
    if (over[`${method} ${url}`]) return over[`${method} ${url}`](payload);
    if (url === '/api/mail/mailboxes') return { mailboxes: fresh(MB), viewer: { su: false, role: null, can_send: true }, inbox_unread_distinct: 3 };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: [ROW()], next_cursor: null };
    if (url === '/api/mail/threads/root%40x.test') return { thread_key: 'root@x.test', subject: 'Plan objection', truncated: false, messages: [TMSG()] };
    if (url === '/api/mail/read' && method === 'POST') return { marked: (payload && payload.ids ? payload.ids.length : 0) };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [], unmatched: [] };
    if (url === '/api/mail/identities') {
      return { identities: [{ id: 1, address: 'billing@firm.test', display_name: 'Billing', color: null, active: true, send_only: false, sendable: true, reason: null, reason_text: null, signature: false }], max_recipients: 10 };
    }
    if (/^\/api\/mail\/messages\/\d+\/reply$/.test(url)) {
      return { in_reply_to_message_fk: 11, mailbox_id: 1, all: false, to: [{ email: 'jane@client.test', name: 'Jane Doe' }], cc: [], subject: 'Re: Plan objection', quote: { header: 'On …, Jane wrote:', text: 'plain body' }, over_cap: false, max_recipients: 10 };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

const openThread = async (window, doc) => { doc.querySelector('#msg-list .msg').click(); await tick(window, 80); };
const logline = (doc) => doc.querySelector('.mcard .logline');

// ─────────────────────────────────────────────────────────────────────────────
describe('A.2 — the log-status line', () => {
  const states = [
    [{ state: 'case', case: { case_id: 'CaseA1', case_number: '26-11111' }, log_id: 9, via: 'stamped' }, /On the log of.*26-11111.*Change/s, false],
    [{ state: 'logged', log_id: 9, via: 'copy' }, /On the firm log, not on a case/, true],
    [{ state: 'pending' }, /Still syncing; its log entry is on the way/, false],
    [{ state: 'firm_to_firm' }, /mail between firm addresses is skipped/, true],
    [{ state: 'suppressed' }, /a suppression rule skipped it/, true],
    [{ state: 'pipeline_error' }, /the mail rules failed on it/, true],
    [{ state: 'history' }, /Older mail, stored before YisraCase read this mailbox/, true],
    [{ state: 'store_only' }, /this mailbox only stores mail/, true],
  ];
  test.each(states)('state %j wording + case action', async (st, re, hasLink) => {
    const { window, doc } = await boot({
      handler: standard({ 'GET /api/mail/threads/root%40x.test': () => ({ thread_key: 'root@x.test', subject: 's', truncated: false, messages: [TMSG({ log_status: fresh(st) })] }) }),
    });
    await openThread(window, doc);
    const line = logline(doc);
    expect(line.textContent).toMatch(re);
    expect([...line.querySelectorAll('button')].some((b) => b.textContent === 'Link to case')).toBe(hasLink);
  });

  test('the line is the case ACTION: Link to case opens the picker; after linking it reads "On the log of … Change"', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'POST /api/mail/messages/11/case-link': () => ({ id: 11, log_id: 77, log_created: true, case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } }),
        'GET /api/cases/search': () => ({ cases: [{ case_id: 'CaseA1', case_number: '26-11111' }] }),
      }),
    });
    await openThread(window, doc);
    [...logline(doc).querySelectorAll('button')].find((b) => b.textContent === 'Link to case').click();
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(true);
    const q = doc.getElementById('case-q');
    q.value = '26'; q.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    doc.querySelector('#case-results li').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/messages/11/case-link').payload).toEqual({ case_id: 'CaseA1' });
    expect(logline(doc).textContent).toMatch(/On the log of.*26-11111-tjt.*Change/s);
  });

  test('F/G riders: "Sent by X via YisraCase"; "Linking to …" while pending; the failed chip when it gave up', async () => {
    const mk = (over) => () => ({ thread_key: 'root@x.test', subject: 's', truncated: false, messages: [TMSG(over)] });
    let b = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': mk({ sent_by: { user: 2, name: 'Rena R' } }) }) });
    await openThread(b.window, b.doc);
    expect(logline(b.doc).textContent).toMatch(/· Sent by Rena R via YisraCase/);
    b = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': mk({ sent_by: { user: 2, name: 'Rena R' }, sent_link: { state: 'pending', case: { case_id: 'CaseA1', case_number: '26-11111' } } }) }) });
    await openThread(b.window, b.doc);
    expect(logline(b.doc).textContent).toMatch(/Linking to 26-11111…/);
    b = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': mk({ sent_link: { state: 'failed', case: { case_id: 'CaseA1', case_number: '26-11111' } } }) }) });
    await openThread(b.window, b.doc);
    expect(logline(b.doc).textContent).toMatch(/Linking to 26-11111 failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('B — merged rows in the pane', () => {
  test('a chip per copy, labelled by display name else local part; a later page\'s copy FOLDS into the shown row', async () => {
    const twinP1 = ROW({ id: 11, unread: false });
    const twinP2 = ROW({
      id: 31, mailbox_id: 2, mailbox_address: 'intake-with-a-long-name@firm.test', unread: true,
      copies: [{ id: 31, mailbox_id: 2, mailbox_address: 'intake-with-a-long-name@firm.test', folder: 'INBOX', place: null, unread: true }],
    });
    let page = 0;
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/messages': () => (page++ === 0
          ? { messages: [fresh(twinP1)], next_cursor: '100.11' }
          : { messages: [fresh(twinP2)], next_cursor: null }),
      }),
    });
    expect(doc.querySelectorAll('#msg-list .msg')).toHaveLength(1);
    doc.getElementById('more-btn').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/mail/messages')[1].payload.cursor).toBe('100.11');
    const rows = doc.querySelectorAll('#msg-list .msg');
    expect(rows).toHaveLength(1); // folded — never a second row
    const chips = [...rows[0].querySelectorAll('.chip.box')].map((c) => c.textContent);
    expect(chips).toEqual(['Billing', 'intake-with-a-long-name@']); // D.6: name, else local part
    expect(rows[0].classList.contains('unread')).toBe(true); // the folded copy was unread
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('C — the sync line', () => {
  test('"Checked N min ago" (the OLDEST in scope) + a warning chip per stale/failing box', async () => {
    const { doc } = await boot({ handler: standard() });
    const line = doc.getElementById('sync-line');
    expect(line.textContent).toMatch(/^Checked \d+ (min|hour)/);
    const warn = line.querySelector('.sync-warn');
    expect(warn.textContent).toMatch(/intake-with-a-long-name@ — not checked since/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D.1 — the ⋯ menu', () => {
  test('one menu at a time; Escape closes it; the same button toggles', async () => {
    const two = [TMSG(), TMSG({ id: 12, message_id: 'm2@x.test', copies: [{ id: 12, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', place: null, unread: false }] })];
    const { window, doc } = await boot({
      handler: standard({ 'GET /api/mail/threads/root%40x.test': () => ({ thread_key: 'root@x.test', subject: 's', truncated: false, messages: fresh(two) }) }),
    });
    await openThread(window, doc);
    const btns = [...doc.querySelectorAll('.menu-btn')];
    expect(btns).toHaveLength(2);
    btns[0].click();
    expect(doc.querySelectorAll('.mmenu')).toHaveLength(1);
    btns[1].click(); // opening the second closes the first
    expect(doc.querySelectorAll('.mmenu')).toHaveLength(1);
    expect(btns[0].getAttribute('aria-expanded')).toBe('false');
    expect(btns[1].getAttribute('aria-expanded')).toBe('true');
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.querySelectorAll('.mmenu')).toHaveLength(0);
    btns[0].click(); btns[0].click(); // toggle
    expect(doc.querySelectorAll('.mmenu')).toHaveLength(0);
  });

  test('menu items: read state, Plain text/Formatted, Taller, Task…, Always show images', async () => {
    const { window, doc } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.menu-btn').click();
    const labels = [...doc.querySelectorAll('.mmenu button')].map((b) => b.textContent.trim());
    expect(labels).toEqual(['Mark unread', 'Plain text', 'Taller', 'Task…', 'Always show images from this sender']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('D.5 — from: in the search box; Filters (n)', () => {
  test('from:court.gov parses into from_domain; the rest stays q; a saved view\'s from_domain shows as from:x', async () => {
    const views = [{ id: 4, name: 'Court', mailbox_ids: null, filters: { from_domain: 'court.gov', q: 'order' }, is_default: true, sort_order: 0 }];
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/mail/views': () => ({ views }) }) });
    expect(doc.getElementById('f-q').value).toBe('order from:court.gov');
    expect(calls.find((c) => c.url === '/api/mail/messages').payload).toMatchObject({ q: 'order', from_domain: 'court.gov' });
    const q = doc.getElementById('f-q');
    q.value = 'from:@uscourts.gov deadline'; q.dispatchEvent(new window.Event('input'));
    await tick(window, 400);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ q: 'deadline', from_domain: 'uscourts.gov' });
    q.value = 'no token here'; q.dispatchEvent(new window.Event('input'));
    await tick(window, 400);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ q: 'no token here', from_domain: '' });
  });

  test('"Filters (n)" counts what narrows; the panel starts collapsed (CSS hides it ≤768 only)', async () => {
    const { window, doc } = await boot({ handler: standard() });
    expect(doc.getElementById('fbar-n').textContent).toBe('Filters');
    expect(doc.getElementById('fbar').dataset.collapsed).toBe('true');
    doc.getElementById('f-unread').click();
    doc.getElementById('f-case-off').click();
    await tick(window);
    expect(doc.getElementById('fbar-n').textContent).toBe('Filters (2)');
    doc.getElementById('fbar-btn').click();
    expect(doc.getElementById('fbar').dataset.collapsed).toBe('false');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('E — Task from email', () => {
  const relThread = () => ({ thread_key: 'root@x.test', subject: 'Plan objection', truncated: false,
    messages: [TMSG({ log_status: { state: 'case', case: { case_id: 'CaseA1', case_number: '26-11111' }, log_id: 9, via: 'stamped' } })] });
  const related = () => ({ contacts: [{ contact_id: 500, name: 'Doe, Jane', kind: 'person', emails: ['jane@client.test'], role: 'from', cases: [{ case_id: 'CaseB2', case_number: '26-22222', case_stage: 'Open' }] }], unmatched: [] });

  test('defaults: title, me as assignee, due today, the message\'s case pre-picked; chips for related cases/contacts + None', async () => {
    const { window, doc } = await boot({
      handler: standard({ 'GET /api/mail/threads/root%40x.test': relThread, 'GET /api/mail/messages/11/related': related }),
    });
    await openThread(window, doc);
    doc.querySelector('.menu-btn').click();
    [...doc.querySelectorAll('.mmenu button')].find((b) => b.textContent === 'Task…').click();
    expect(doc.getElementById('task-backdrop').classList.contains('open')).toBe(true);
    expect(doc.getElementById('task-title').value).toBe('Follow up: Plan objection');
    expect(doc.getElementById('task-to').value).toBe('2'); // the caller
    expect(doc.getElementById('task-due').value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.getElementById('task-desc').value).toMatch(/^Email from Jane Doe on .*: Plan objection\n\nplain body$/);
    const chips = [...doc.querySelectorAll('#task-links .fchip')];
    expect(chips.map((c) => [c.textContent.trim(), c.getAttribute('aria-pressed')])).toEqual([
      ['26-11111', 'true'],    // the message's case, pre-picked (E)
      ['26-22222', 'false'],   // a related client case
      ['Doe, Jane', 'false'],  // a related contact
      ['None', 'false'],
    ]);
  });

  test('+1 business day skips the weekend; the caps are counted and enforced before the POST', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/mail/threads/root%40x.test': relThread, 'GET /api/mail/messages/11/related': related }),
    });
    await openThread(window, doc);
    doc.querySelector('.menu-btn').click();
    [...doc.querySelectorAll('.mmenu button')].find((b) => b.textContent === 'Task…').click();
    const due = doc.getElementById('task-due');
    due.value = '2026-10-16'; // a Friday
    doc.getElementById('task-due-plus').click();
    expect(due.value).toBe('2026-10-19'); // Monday
    const title = doc.getElementById('task-title');
    title.value = 'x'.repeat(101); title.dispatchEvent(new window.Event('input'));
    expect(doc.getElementById('task-title-n').textContent).toBe('101/100');
    doc.getElementById('task-save').click();
    await tick(window, 40);
    expect(doc.getElementById('task-msg').textContent).toMatch(/101 characters.*limit is 100/);
    expect(calls.some((c) => c.url === '/api/tasks')).toBe(false);
  });

  test('Create task POSTs source comms + the picked link; the toast offers Open tasks (the shell tab)', async () => {
    const { window, doc, calls, opened } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': relThread,
        'GET /api/mail/messages/11/related': related,
        'POST /api/tasks': () => ({ status: 'success', task_id: 77 }),
      }),
    });
    await openThread(window, doc);
    doc.querySelector('.menu-btn').click();
    [...doc.querySelectorAll('.mmenu button')].find((b) => b.textContent === 'Task…').click();
    // switch the link to the related CONTACT, and the assignee to Stuart
    [...doc.querySelectorAll('#task-links .fchip')].find((c) => c.textContent.trim() === 'Doe, Jane').click();
    doc.getElementById('task-to').value = '1';
    doc.getElementById('task-save').click();
    await tick(window, 40);
    const post = calls.find((c) => c.url === '/api/tasks');
    expect(post.method).toBe('POST');
    expect(post.payload).toMatchObject({ to: 1, title: 'Follow up: Plan objection', source: 'comms', link_type: 'contact', link_id: '500' });
    expect(post.payload.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(doc.getElementById('task-backdrop').classList.contains('open')).toBe(false);
    const action = doc.querySelector('#toast .linkish');
    expect(doc.getElementById('toast').textContent).toMatch(/Task created/);
    action.click();
    expect(opened).toHaveLength(1);
  });

  test('a visible Task button rides the header too (shown ≥1000px by CSS)', async () => {
    const { window, doc } = await boot({ handler: standard() });
    await openThread(window, doc);
    const btn = doc.querySelector('.mhead .task-btn');
    expect(btn).not.toBeNull();
    btn.click();
    expect(doc.getElementById('task-backdrop').classList.contains('open')).toBe(true);
    expect(HTML).toMatch(/@media \(min-width: 1000px\) \{ \.mhead \.task-btn \{ display: inline-flex; \} \}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('G — the composer\'s Case field', () => {
  test('a reply DEFAULTS to the replied-to message\'s case; Remove clears it; case_id rides the send body', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': () => ({ thread_key: 'root@x.test', subject: 's', truncated: false,
          messages: [TMSG({ log_status: { state: 'case', case: { case_id: 'CaseA1', case_number: '26-11111' }, log_id: 9, via: 'stamped' } })] }),
        'POST /api/mail/send': () => ({ status: 'success', from: 'billing@firm.test', case_link: { state: 'pending', job_id: 5 }, warnings: [], read_seed: {}, append: {} }),
      }),
    });
    await openThread(window, doc);
    doc.querySelector('.mhead .reply-btn').click();
    await tick(window, 60);
    const field = doc.querySelector('.composer .case-row .cf-field');
    expect(field.querySelector('.chip.case').textContent).toContain('26-11111'); // the default
    doc.querySelector('.composer .cf-body').value = 'my reply';
    doc.querySelector('.composer .cf-body').dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 60);
    const sent = calls.find((c) => c.url === '/api/mail/send');
    expect(sent.payload.case_id).toBe('CaseA1');
    expect(doc.getElementById('toast').textContent).toMatch(/on the case's log once the copy is stored/);
  });

  test('a NEW message never auto-picks: a picked recipient\'s cases become one-click chips; untouched, no case_id is sent', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/contacts': () => ({ contacts: [{ contact_id: 500, contact_name: 'Doe, Jane', contact_email: 'jane@client.test',
          cases: [{ case_id: 'CaseA1', case_number: '26-11111' }, { case_id: 'CaseB2', case_number: '26-22222' }] }] }),
        'POST /api/mail/send': () => ({ status: 'success', from: 'billing@firm.test', case_link: { state: null, job_id: null }, warnings: [], read_seed: {}, append: {} }),
      }),
    });
    doc.getElementById('compose-btn').click();
    await tick(window, 60);
    const toInput = doc.querySelector('.composer .cf-row[data-field="to"] input');
    toInput.value = 'jane';
    toInput.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    doc.querySelector('.composer .sugg-list li').click();
    const field = doc.querySelector('.composer .case-row .cf-field');
    expect(field.querySelector('.chip.case')).toBeNull(); // two cases — NEVER auto-picked
    const suggs = [...field.querySelectorAll('.fchip')].map((c) => c.textContent.trim());
    expect(suggs).toEqual(['26-11111', '26-22222']);
    doc.querySelector('.composer .cf-subject').value = 'subj';
    doc.querySelector('.composer .cf-subject').dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .cf-body').value = 'text';
    doc.querySelector('.composer .cf-body').dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 60);
    const sent = calls.find((c) => c.url === '/api/mail/send');
    expect(sent.payload.case_id).toBeUndefined();
    // …and picking a chip would have sent it:
  });

  test('New message\'s case picker never offers the open thread\'s cases — only the picked recipients\'', async () => {
    // Live 2026-10-13: with a thread open, New message → "Pick a case…" listed
    // THAT thread's related cases as "From this conversation" — one click from
    // putting the new mail on the wrong case's log. (The picker also rendered
    // UNDER the composer: CSS, gated in real Chromium by commsDensity.js.)
    const { window, doc } = await boot({
      handler: standard({
        'GET /api/mail/messages/11/related': () => ({ contacts: [{ contact_id: 600, name: 'Roe, Other', kind: 'person', emails: ['other@client.test'], role: 'from',
          cases: [{ case_id: 'CaseT9', case_number: '26-99999', case_stage: 'Open' }] }], unmatched: [] }),
        'GET /api/contacts': () => ({ contacts: [{ contact_id: 500, contact_name: 'Doe, Jane', contact_email: 'jane@client.test',
          cases: [{ case_id: 'CaseA1', case_number: '26-11111' }] }] }),
      }),
    });
    await openThread(window, doc); // the thread behind: its related contact carries CaseT9
    const pickerSuggs = () => (doc.getElementById('case-sugg-wrap').hidden ? [] : [...doc.querySelectorAll('#case-sugg li .l1')].map((li) => li.textContent));
    // control: the reply-side picker DOES offer the conversation's case
    [...logline(doc).querySelectorAll('button')].find((b) => b.textContent === 'Link to case').click();
    expect(pickerSuggs().join(' ')).toContain('26-99999');
    expect(doc.getElementById('case-sugg-label').textContent).toBe('From this conversation');
    window.closeCaseLink();
    doc.getElementById('compose-btn').click();
    await tick(window, 60);
    const pick = () => [...doc.querySelectorAll('.composer .case-row button.linkish')].find((b) => /Pick a case/.test(b.textContent));
    pick().click();
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(true);
    expect(pickerSuggs()).toEqual([]); // no recipients yet → nothing offered, and never CaseT9
    window.closeCaseLink();
    const toInput = doc.querySelector('.composer .cf-row[data-field="to"] input');
    toInput.focus(); // as a person does — focus was left in the closed picker's search box
    toInput.value = 'jane'; toInput.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    doc.querySelector('.composer .sugg-list li').click();
    pick().click();
    const offered = pickerSuggs().join(' ');
    expect(offered).toContain('26-11111'); // the recipient's case
    expect(offered).not.toContain('26-99999'); // never the thread behind
    expect(doc.getElementById('case-sugg-label').textContent).toBe('From your recipients');
  });

  test('picking a suggestion chip sends that case', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/contacts': () => ({ contacts: [{ contact_id: 500, contact_name: 'Doe, Jane', contact_email: 'jane@client.test',
          cases: [{ case_id: 'CaseA1', case_number: '26-11111' }] }] }),
        'POST /api/mail/send': () => ({ status: 'success', from: 'billing@firm.test', case_link: { state: 'linked', job_id: null }, warnings: [], read_seed: {}, append: {} }),
      }),
    });
    doc.getElementById('compose-btn').click();
    await tick(window, 60);
    const toInput = doc.querySelector('.composer .cf-row[data-field="to"] input');
    toInput.value = 'jane'; toInput.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    doc.querySelector('.composer .sugg-list li').click();
    const field = doc.querySelector('.composer .case-row .cf-field');
    [...field.querySelectorAll('.fchip')].find((c) => c.textContent.trim() === '26-11111').click();
    expect(field.querySelector('.chip.case').textContent).toContain('26-11111');
    doc.querySelector('.composer .cf-subject').value = 'subj';
    doc.querySelector('.composer .cf-subject').dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .cf-body').value = 'text';
    doc.querySelector('.composer .cf-body').dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/send').payload.case_id).toBe('CaseA1');
    expect(doc.getElementById('toast').textContent).toMatch(/It is on the case's log\./);
  });
});
