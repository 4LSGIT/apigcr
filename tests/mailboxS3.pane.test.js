/**
 * @jest-environment node
 *
 * tests/mailboxS3.pane.test.js — compose / reply / Sent in the comms hub pane
 * (public/comms.html), mailbox-system arc slice S3.
 * Run: npx jest tests/mailboxS3.pane.test.js
 *
 * Boots the real pane in jsdom against a stub shell apiSend (the S2 pane
 * harness), drives it through the DOM. What is locked:
 *   - Boot makes NO new call: Compose / Reply show from the summary's
 *     can_send; the identity list loads when a composer first opens.
 *   - From = the server's identities: sendable ones pressable, the rest
 *     disabled with their reason; one pressed.
 *   - Recipients are chips: typed + Enter / comma, pasted lists (a quoted
 *     "Doe, Jane" stays one), Backspace removes, duplicates once, the cap,
 *     a non-address is refused and stays in the box. Contact type-ahead hits
 *     GET /api/contacts (q, limit 8); keyboard and click pick; a contact
 *     without an email is not pickable; names render as TEXT.
 *   - The send payload is exactly what the composer shows; errors stay in the
 *     composer; Send is disabled while in flight; success closes + toasts.
 *   - Reply / Reply all: GET …/reply (all 0/1), a reply box at the END of the
 *     conversation with the server's To / Cc / subject / quote; the quote is
 *     text; payload carries in_reply_to_message_fk + quote_original.
 *   - Drafts: closing keeps the text for this page's life (never storage);
 *     Discard asks; leaving with unsent text asks (beforeunload).
 *   - Inbox | Sent | All folders: Sent sends sent_only=1 (and all_folders 0);
 *     Inbox / All folders send no sent_only (the S2 payloads, unchanged).
 *   - After a reply, the conversation is re-read until the copy arrives.
 *
 * Mutation-checked (worker report 2026-10-11): identities fetched at boot →
 * "boot makes no new call"; addRecipient without the duplicate check / cap →
 * chip tests; sent_only sent with Inbox → scope test; quote_original always
 * true → reply test; the reply box not re-attached by renderThread → "survives
 * a re-render"; drafts not kept on close → draft test.
 * Reviewer additions (2026-10-11): closeComposer without its in-flight guard
 * (✕ / Esc mid-send kept the text as a draft with Send live → a second POST)
 * → "a send in flight cannot be closed"; the carried text dropped on Reply ↔
 * Reply all → "keeps what was written"; no toast for a failure whose box is
 * off screen → "a reply still sending when another conversation is opened".
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

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const EVIL = '<img src=x onerror="window.top.__pwned=1">';

const MB = [
  { id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 2 },
  { id: 2, address: 'intake@firm.test', display_name: null, color: '#fff3bf', active: true, can_send: false, can_manage: false, inbox_total: 1, inbox_unread: 1 },
];
const IDENTITIES = {
  max_recipients: 10,
  identities: [
    { id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, sendable: true, reason: null, reason_text: null, signature: true },
    { id: 3, address: 'nosend@firm.test', display_name: null, color: null, active: true, sendable: false, reason: 'no_send_credential', reason_text: 'Read-only: no send credential', signature: false },
  ],
};
const ROWS = [
  { id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null, thread_key: 'root@x.test', from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test', cc_addrs: null, subject: 'Plan', date: '2026-10-08T14:00:00.000Z', snippet: 's', unread: false, attachment_count: 0, log_id: null, case: null },
];
const THREAD = {
  thread_key: 'root@x.test', subject: 'Plan', truncated: false,
  messages: [{
    id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null, message_id: 'root@x.test', thread_key: 'root@x.test',
    from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test', cc_addrs: 'jane@outside.test', subject: 'Plan', date: '2026-10-08T14:00:00.000Z', snippet: 's',
    body_text: 'hello', body_html: null, attachments: [], unread: false, log_id: null, case: null,
    copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', place: null, unread: false }],
  }],
};
const REPLY = (all) => ({
  in_reply_to_message_fk: 11, mailbox_id: 1, all, max_recipients: 10, over_cap: false, subject: 'Re: Plan',
  to: [{ email: 'client@outside.test', name: `Client ${EVIL}` }],
  cc: all ? [{ email: 'jane@outside.test', name: null }] : [],
  quote: { header: 'On Thu, Oct 8, 2026 at 10:00 AM, Client <client@outside.test> wrote:', text: `hello ${EVIL}` },
});
const fresh = (v) => JSON.parse(JSON.stringify(v));

async function boot({ handler, mailboxes = MB, before = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  if (before) before(window);
  window.Element.prototype.scrollIntoView = function () {};
  window.firmData = { firmTimezone: 'America/Detroit' };
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null, headers = {}, opts = {}) => {
    calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)), opts });
    return handler(url, method, payload, opts, { mailboxes });
  };
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [PURIFY, RENDER, COLOR, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  window.COMPOSE_LIMITS.suggestDelayMs = 5;
  window.COMPOSE_LIMITS.blurDelayMs = 5;
  await tick(window, 80);
  return { window, doc: window.document, calls, errors };
}

function standard(over = {}) {
  return (url, method, payload, opts, ctx) => {
    if (over[`${method} ${url}`]) return over[`${method} ${url}`](payload, opts);
    if (url === '/api/mail/mailboxes') return { mailboxes: fresh(ctx.mailboxes), viewer: { su: false, role: null } };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: fresh(ROWS), next_cursor: null };
    if (url === '/api/mail/threads/root%40x.test') return fresh(THREAD);
    if (url === '/api/mail/read' && method === 'POST') return { marked: 0 };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [] };
    if (url === '/api/mail/identities') return fresh(IDENTITIES);
    if (url === '/api/mail/messages/11/reply') return fresh(REPLY(payload && payload.all === 1));
    if (url === '/api/contacts') return { contacts: [] };
    if (url === '/api/mail/send' && method === 'POST') return { status: 'success', from: 'billing@firm.test', email_log_id: 5, warnings: [], append: {}, read_seed: {} };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

const on = (doc, id) => doc.getElementById(id).getAttribute('aria-pressed') === 'true';
const chips = (doc, field) => [...doc.querySelectorAll(`.composer .rcpt[data-field="${field}"] .rchip`)].map((c) => c.querySelector('.nm').textContent);
const input = (doc, field) => doc.querySelector(`.composer .rcpt[data-field="${field}"] input`);
function type(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function key(window, el, k) {
  const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}
async function openCompose(window, doc) {
  doc.getElementById('compose-btn').click();
  await tick(window, 40);
}

describe('compose (S3)', () => {
  test('boot makes no new call; Compose shows only when a readable box can send', async () => {
    const { doc, calls, errors } = await boot({ handler: standard() });
    expect(errors).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual(['/api/mail/mailboxes', '/api/mail/views', '/api/mail/messages']);
    expect([doc.getElementById('compose-btn').hidden, doc.getElementById('rail-compose').hidden]).toEqual([false, false]);
    const ro = await boot({ handler: standard(), mailboxes: MB.map((m) => ({ ...m, can_send: false })) });
    expect([ro.doc.getElementById('compose-btn').hidden, ro.doc.getElementById('rail-compose').hidden]).toEqual([true, true]);
  });

  test('From: the server\'s identities — the sendable one pressed, the read-only one disabled with its reason', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openCompose(window, doc);
    expect(calls.filter((c) => c.url === '/api/mail/identities')).toHaveLength(1);
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(true);
    const ids = [...doc.querySelectorAll('.composer .ident')];
    expect(ids.map((b) => [b.dataset.id, b.getAttribute('aria-pressed'), b.disabled])).toEqual([['1', 'true', false], ['3', 'false', true]]);
    expect(ids[1].title).toMatch(/Read-only/);
    expect(doc.querySelector('.composer .sig-label').hidden).toBe(false);   // billing has its own signature
    expect(doc.querySelector('.composer .sig-box').checked).toBe(true);
    // the identity list is cached for the page
    doc.getElementById('compose-close').click();
    await openCompose(window, doc);
    expect(calls.filter((c) => c.url === '/api/mail/identities')).toHaveLength(1);
  });

  test('recipient chips: Enter / comma / paste (a quoted comma stays one), duplicates once, Backspace, a non-address refused', async () => {
    const { window, doc } = await boot({ handler: standard() });
    await openCompose(window, doc);
    const to = input(doc, 'to');
    type(window, to, 'a@b.test');
    key(window, to, 'Enter');
    type(window, to, 'c@d.test,');
    type(window, to, '"Doe, Jane" <jane@x.test>; A@B.test\n');
    expect(chips(doc, 'to')).toEqual(['a@b.test', 'c@d.test', 'Doe, Jane']);
    type(window, to, 'not-an-address');
    key(window, to, 'Enter');
    expect(to.value).toBe('not-an-address');
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/not an email address/);
    type(window, to, '');
    key(window, to, 'Backspace');
    expect(chips(doc, 'to')).toEqual(['a@b.test', 'c@d.test']);
    expect(doc.querySelector('.composer .cf-count').textContent).toBe('2 of 10 recipients');
  });

  test('the cap: an 11th recipient is refused', async () => {
    const { window, doc } = await boot({ handler: standard() });
    await openCompose(window, doc);
    const to = input(doc, 'to');
    type(window, to, Array.from({ length: 10 }, (_, i) => `p${i}@x.test`).join(', ') + ',');
    expect(chips(doc, 'to')).toHaveLength(10);
    type(window, to, 'p10@x.test');
    key(window, to, 'Enter');
    expect(chips(doc, 'to')).toHaveLength(10);
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/At most 10 recipients/);
  });

  test('contact type-ahead: GET /api/contacts; names are text; a contact without email cannot be picked; keyboard + click', async () => {
    const contacts = [
      { contact_id: 7, contact_name: `Jane ${EVIL}`, contact_email: 'jane@client.test', cases: JSON.stringify([{ case_id: 'C1', case_number: '26-111' }, { case_id: 'C2', case_number: '26-222' }]) },
      { contact_id: 8, contact_name: 'Janet NoMail', contact_email: '', cases: [{ case_id: null, case_number: null }] },
      { contact_id: 9, contact_name: 'Janis', contact_email: 'janis@client.test', cases: [] },
    ];
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/contacts': () => ({ contacts }) }) });
    await openCompose(window, doc);
    const to = input(doc, 'to');
    type(window, to, 'Jan');
    await tick(window, 40);
    expect(calls.find((c) => c.url === '/api/contacts').payload).toEqual({ q: 'Jan', limit: 8 });
    const items = [...doc.querySelectorAll('.composer .sugg-list li')];
    expect(items.map((li) => [li.querySelector('.l1').textContent, li.querySelector('.l2').textContent, li.getAttribute('aria-disabled')])).toEqual([
      [`Jane ${EVIL}`, 'jane@client.test · 26-111 +1', null],
      ['Janet NoMail', 'no email on file', 'true'],
      ['Janis', 'janis@client.test', null],
    ]);
    expect(doc.querySelector('.composer img')).toBeNull();
    key(window, to, 'ArrowDown'); // skips the disabled one
    key(window, to, 'Enter');
    expect(chips(doc, 'to')).toEqual(['Janis']);
    type(window, to, 'Jan');
    await tick(window, 40);
    doc.querySelectorAll('.composer .sugg-list li')[1].click();          // no email: nothing happens
    expect(chips(doc, 'to')).toEqual(['Janis']);
    doc.querySelectorAll('.composer .sugg-list li')[0].click();
    expect(chips(doc, 'to')).toEqual(['Janis', `Jane ${EVIL}`]);
    expect(window.__pwned).toBeUndefined();
  });

  test('send: the exact payload; Send disabled in flight; success closes and toasts', async () => {
    let release;
    const { window, doc, calls } = await boot({ handler: standard({
      'POST /api/mail/send': () => new Promise((r) => { release = () => r({ from: 'billing@firm.test', warnings: [{ code: 'append_failed', message: 'Sent, but saving a copy failed.' }] }); }),
    }) });
    await openCompose(window, doc);
    type(window, input(doc, 'to'), '"Client" <client@outside.test>,');
    doc.querySelector('.composer .cc-link').click();
    type(window, input(doc, 'cc'), 'cc@outside.test,');
    doc.querySelector('.composer .bcc-link').click();
    type(window, input(doc, 'bcc'), 'hidden@outside.test');           // still typed: Send commits it
    const subj = doc.querySelector('.composer .cf-subject');
    subj.value = 'Hello'; subj.dispatchEvent(new window.Event('input'));
    const body = doc.querySelector('.composer .cf-body');
    body.value = 'Hi there'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 20);
    expect(doc.querySelector('.composer .send-btn').disabled).toBe(true);
    doc.querySelector('.composer .send-btn').click();                   // a double click sends once
    release();
    await tick(window, 40);
    const sends = calls.filter((c) => c.url === '/api/mail/send');
    expect(sends).toHaveLength(1);
    expect(sends[0].payload).toEqual({
      mailbox_id: 1, to: [{ email: 'client@outside.test', name: 'Client' }], cc: ['cc@outside.test'], bcc: ['hidden@outside.test'],
      subject: 'Hello', body_text: 'Hi there', signature: true,
    });
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(false);
    expect(doc.getElementById('toast').textContent).toMatch(/Sent from billing@firm\.test\. Sent, but saving a copy failed\./);
  });

  test('a send in flight cannot be closed, discarded or reopened as a draft — one POST, never a second copy', async () => {
    let release;
    const { window, doc, calls } = await boot({ handler: standard({
      'POST /api/mail/send': () => new Promise((r) => { release = () => r({ from: 'billing@firm.test', warnings: [] }); }),
    }) });
    await openCompose(window, doc);
    type(window, input(doc, 'to'), 'client@outside.test,');
    const subj = doc.querySelector('.composer .cf-subject'); subj.value = 'Hello'; subj.dispatchEvent(new window.Event('input'));
    const body = doc.querySelector('.composer .cf-body'); body.value = 'Hi there'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 20);
    doc.getElementById('compose-close').click();                                              // ✕ …
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // … Esc …
    window.confirm = () => true;
    doc.querySelector('.composer .discard-btn').click();                                      // … Discard: all ignored
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(true);
    expect(window.eval("state.drafts.size")).toBe(0);                                         // text in flight is not a draft
    await openCompose(window, doc);                                                           // Compose again: still the one in flight
    expect(doc.querySelector('.composer .send-btn').disabled).toBe(true);
    doc.querySelector('.composer .send-btn').click();
    release();
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/send')).toHaveLength(1);
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(false);
    await openCompose(window, doc);
    expect(doc.querySelector('.composer .cf-body').value).toBe('');                           // sent: nothing left to resend
  });

  test('a refused send keeps the composer, shows the server\'s words, re-enables Send', async () => {
    const { window, doc } = await boot({ handler: standard({ 'POST /api/mail/send': () => { throw new Error('This mailbox\'s sending account has reached its daily limit'); } }) });
    await openCompose(window, doc);
    type(window, input(doc, 'to'), 'c@x.test,');
    const subj = doc.querySelector('.composer .cf-subject'); subj.value = 'S'; subj.dispatchEvent(new window.Event('input'));
    const body = doc.querySelector('.composer .cf-body'); body.value = 'B'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 40);
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(true);
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/daily limit/);
    expect(doc.querySelector('.composer .send-btn').disabled).toBe(false);
  });

  test('client checks before any call: no recipient / subject / text', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openCompose(window, doc);
    doc.querySelector('.composer .send-btn').click();
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/at least one recipient/);
    type(window, input(doc, 'to'), 'c@x.test,');
    doc.querySelector('.composer .send-btn').click();
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/subject/);
    expect(calls.filter((c) => c.url === '/api/mail/send')).toEqual([]);
  });

  test('drafts: closing keeps the text for this page (never in storage); Discard asks and clears; leaving with text asks', async () => {
    const stored = [];
    const { window, doc } = await boot({ handler: standard(), before: (w) => { const set = w.Storage.prototype.setItem; w.Storage.prototype.setItem = function (k, v) { stored.push(k); return set.call(this, k, v); }; } });
    await openCompose(window, doc);
    const body = doc.querySelector('.composer .cf-body');
    body.value = 'half a thought'; body.dispatchEvent(new window.Event('input'));
    doc.getElementById('compose-close').click();
    const ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await openCompose(window, doc);
    expect(doc.querySelector('.composer .cf-body').value).toBe('half a thought');
    window.confirm = () => false;
    doc.querySelector('.composer .discard-btn').click();
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(true);
    window.confirm = () => true;
    doc.querySelector('.composer .discard-btn').click();
    await openCompose(window, doc);
    expect(doc.querySelector('.composer .cf-body').value).toBe('');
    expect(stored.filter((k) => !/rail/.test(k))).toEqual([]);   // nothing but the rail toggle ever hits storage
  });
});

describe('reply (S3)', () => {
  async function openThread(window, doc) {
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
  }

  test('Reply: the server\'s defaults in a box at the END of the conversation; the quote is text; the payload threads', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.mactions .reply-btn').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/messages/11/reply').payload).toEqual({ all: 0 });
    const box = doc.querySelector('#thread-body .reply-box');
    expect(doc.querySelector('#thread-body').lastElementChild).toBe(box);
    expect(chips(doc, 'to')).toEqual([`Client ${EVIL}`]);
    expect(doc.querySelector('.composer .cf-subject').value).toBe('Re: Plan');
    expect(box.querySelector('.qtext').textContent).toBe(`hello ${EVIL}`);
    expect(box.querySelector('img')).toBeNull();
    expect(doc.querySelector('.composer .rcpt[data-field="cc"]').closest('.cf-row').hidden).toBe(true);
    const body = doc.querySelector('.composer .cf-body'); body.value = 'Thanks'; body.dispatchEvent(new window.Event('input'));
    box.querySelector('.quote-box').click(); // leave the original out
    box.querySelector('.send-btn').click();
    await tick(window, 40);
    expect(calls.find((c) => c.url === '/api/mail/send').payload).toEqual({
      mailbox_id: 1, to: [{ email: 'client@outside.test', name: `Client ${EVIL}` }], subject: 'Re: Plan', body_text: 'Thanks',
      signature: true, in_reply_to_message_fk: 11, quote_original: false,
    });
    expect(doc.querySelector('#thread-body .reply-box')).toBeNull();
  });

  test('Reply ↔ Reply all on the same message keeps what was written (open box and closed draft)', async () => {
    const { window, doc } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.mactions .reply-btn').click();
    await tick(window, 60);
    let body = doc.querySelector('.reply-box .cf-body'); body.value = 'Three careful paragraphs'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.mactions .reply-all-btn').click();                 // open box → Reply all
    await tick(window, 60);
    expect(doc.querySelectorAll('#thread-body .reply-box')).toHaveLength(1);
    expect(doc.querySelector('.reply-box .cf-title').textContent).toBe('Reply all');
    expect(doc.querySelector('.reply-box .cf-body').value).toBe('Three careful paragraphs');
    expect(chips(doc, 'cc')).toEqual(['jane@outside.test']);              // the recipients are the new mode's
    doc.querySelector('.reply-box .cf-head .btn.icon').click();           // close → a draft
    doc.querySelector('.mactions .reply-btn').click();                    // closed draft → Reply
    await tick(window, 60);
    expect(doc.querySelector('.reply-box .cf-title').textContent).toBe('Reply');
    expect(doc.querySelector('.reply-box .cf-body').value).toBe('Three careful paragraphs');
    expect(chips(doc, 'cc')).toEqual([]);
  });

  test('a reply still sending when another conversation is opened: not kept as a draft; a failure is announced', async () => {
    let fail;
    const { window, doc, calls } = await boot({ handler: standard({
      'POST /api/mail/send': () => new Promise((_, rej) => { fail = () => rej(new Error('The message was not sent: relay down')); }),
    }) });
    await openThread(window, doc);
    doc.querySelector('.mactions .reply-btn').click();
    await tick(window, 60);
    const body = doc.querySelector('.reply-box .cf-body'); body.value = 'Thanks'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.reply-box .send-btn').click();
    await tick(window, 20);
    window.eval("openMessage({ id: 99, thread_key: 'other@x.test', subject: 'Other' })").catch(() => {}); // the reader moves on mid-send
    await tick(window, 20);
    expect(window.eval('state.drafts.size')).toBe(0);
    fail();
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/send')).toHaveLength(1);
    expect(doc.getElementById('toast').textContent).toMatch(/Not sent: The message was not sent: relay down/);
    expect(window.eval('state.composer && state.composer.body')).toBe('Thanks');   // the text is still there to retry
  });

  test('Reply all: all=1 and the Cc row shows the server\'s Cc', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.mactions .reply-all-btn').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/messages/11/reply').payload).toEqual({ all: 1 });
    expect(chips(doc, 'cc')).toEqual(['jane@outside.test']);
    expect(doc.querySelector('.composer .rcpt[data-field="cc"]').closest('.cf-row').hidden).toBe(false);
  });

  test('no Reply buttons when no readable box can send', async () => {
    const { window, doc } = await boot({ handler: standard(), mailboxes: MB.map((m) => ({ ...m, can_send: false })) });
    await openThread(window, doc);
    expect(doc.querySelector('.mactions .reply-btn')).toBeNull();
  });

  test('the reply box survives a re-render of its conversation; after sending, the conversation is re-read until the copy arrives', async () => {
    let thread = fresh(THREAD);
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': () => fresh(thread) }) });
    window.COMPOSE_LIMITS.watchEveryMs = 30;
    await openThread(window, doc);
    doc.querySelector('.mactions .reply-btn').click();
    await tick(window, 60);
    doc.querySelector('#msg-list .msg').click();                       // re-open the same conversation
    await tick(window, 80);
    expect(doc.querySelector('#thread-body .reply-box')).not.toBeNull();
    const body = doc.querySelector('.composer .cf-body'); body.value = 'Thanks'; body.dispatchEvent(new window.Event('input'));
    doc.querySelector('.reply-box .send-btn').click();
    await tick(window, 50);
    const before = calls.filter((c) => c.url === '/api/mail/threads/root%40x.test').length;
    await tick(window, 80);
    expect(calls.filter((c) => c.url === '/api/mail/threads/root%40x.test').length).toBeGreaterThan(before); // polling, nothing new yet
    const copy = { ...fresh(THREAD.messages[0]), id: 12, message_id: 'mine@firm.test', from_addr: 'billing@firm.test', unread: true,
      copies: [{ id: 12, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX.Sent', place: 'INBOX.Sent', unread: true }] };
    thread = { ...fresh(THREAD), messages: [...fresh(THREAD).messages, copy] };
    await tick(window, 200);
    expect(doc.querySelectorAll('#thread-body .mcard')).toHaveLength(2);
    expect(calls.filter((c) => c.url === '/api/mail/read').pop().payload).toEqual({ ids: [12] });
  });
});

describe('Inbox | Sent | All folders (S3)', () => {
  test('Sent sends sent_only=1 (all_folders 0); Inbox and All folders keep the S2 payload', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    const last = () => calls.filter((c) => c.url === '/api/mail/messages').pop().payload;
    doc.getElementById('f-sent').click();
    await tick(window);
    expect([on(doc, 'f-inbox'), on(doc, 'f-sent'), on(doc, 'f-folders')]).toEqual([false, true, false]);
    expect([last().sent_only, last().all_folders]).toEqual([1, 0]);
    doc.getElementById('f-folders').click();
    await tick(window);
    expect([last().sent_only, last().all_folders]).toEqual([undefined, 1]);
    doc.getElementById('f-inbox').click();
    await tick(window);
    expect([last().sent_only, last().all_folders]).toEqual([undefined, 0]);
  });

  test('a view scoped to Sent restores the Sent button; Save view stores sent_only', async () => {
    const views = [{ id: 4, name: 'Sent', mailbox_ids: null, filters: { sent_only: true }, is_default: true, sort_order: 0 }];
    const { window, doc, calls } = await boot({ handler: standard({
      'GET /api/mail/views': () => ({ views }),
      'POST /api/mail/views': (p) => ({ view: { id: 5, ...p, mailbox_ids: null, sort_order: 0 } }),
    }) });
    expect(on(doc, 'f-sent')).toBe(true);
    expect(calls.find((c) => c.url === '/api/mail/messages').payload.sent_only).toBe(1);
    doc.getElementById('views-btn').click();
    doc.getElementById('vw-name').value = 'Mine';
    doc.getElementById('vw-save').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views' && c.method === 'POST').payload.filters).toEqual({ sent_only: true });
  });
});

describe('Refresh checks the mail servers (S3 follow-up)', () => {
  const lists = (calls) => calls.filter((c) => c.url === '/api/mail/messages' && c.method === 'GET').length;
  const runs = (calls) => calls.filter((c) => c.url === '/mailbox-ingest').length;

  test('Refresh re-reads the list AND starts one ingest pass; new mail → the list again; a second click inside the cooldown starts none', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard({ 'POST /mailbox-ingest': () => ({ skipped: false, stored: 2, backfilled: 0 }) }) });
    const before = lists(calls);
    doc.getElementById('refresh-btn').click();
    await tick(window, 60);
    expect(runs(calls)).toBe(1);
    expect(calls.find((c) => c.url === '/mailbox-ingest').method).toBe('POST');
    expect(lists(calls)).toBe(before + 2);                 // at once, then after the pass stored mail
    doc.getElementById('refresh-btn').click();
    await tick(window, 60);
    expect(runs(calls)).toBe(1);                           // cooldown: the list only
    expect(lists(calls)).toBe(before + 3);
    window.REFRESH_LIMITS.ingestCooldownMs = 0;
    doc.getElementById('refresh-btn').click();
    await tick(window, 60);
    expect(runs(calls)).toBe(2);
    expect(errors).toEqual([]);
  });

  test('nothing new → no second read; the 5-minute pass holding the lock → one read again shortly; a failed pass is quiet', async () => {
    let reply = { skipped: false, stored: 0, backfilled: 0 };
    const { window, doc, calls, errors } = await boot({ handler: standard({ 'POST /mailbox-ingest': () => { if (reply instanceof Error) throw reply; return reply; } }) });
    window.REFRESH_LIMITS.ingestCooldownMs = 0;
    window.REFRESH_LIMITS.lockRetryMs = 20;
    let before = lists(calls);
    doc.getElementById('refresh-btn').click();
    await tick(window, 60);
    expect(lists(calls)).toBe(before + 1);
    reply = { skipped: true, reason: 'another ingest run holds the lock' };
    before = lists(calls);
    doc.getElementById('refresh-btn').click();
    await tick(window, 80);
    expect(lists(calls)).toBe(before + 2);                 // at once + after lockRetryMs
    reply = { skipped: true, throttled: true };
    before = lists(calls);
    doc.getElementById('refresh-btn').click();
    await tick(window, 80);
    expect(lists(calls)).toBe(before + 1);                 // throttled: someone just checked — no retry
    reply = new Error('Mailbox ingest run failed');
    doc.getElementById('refresh-btn').click();
    await tick(window, 60);
    expect(doc.getElementById('refresh-btn').querySelector('i').classList.contains('fa-spin')).toBe(false);
    expect(errors).toEqual([]);
  });

  test('re-entering the tab re-reads the list but never starts a pass', async () => {
    const { window, calls } = await boot({ handler: standard() });
    window.ycBecameVisible();
    await tick(window, 60);
    expect(runs(calls)).toBe(0);
  });
});
