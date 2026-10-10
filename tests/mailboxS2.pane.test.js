/**
 * @jest-environment node
 *
 * tests/mailboxS2.pane.test.js — the comms hub pane (public/comms.html),
 * mailbox-system arc slice S2. Run: npx jest tests/mailboxS2.pane.test.js
 *
 * BOOTS the real pane in jsdom — the real vendored DOMPurify and the real
 * public/js/mailRender.js load as classic scripts — against a stub shell
 * apiSend, and drives it through the DOM. In jsdom a top-level window is its
 * own parent, so window.apiSend IS the pane's P.apiSend.
 *
 * WHAT IS LOCKED
 *   - Mail content never becomes markup: a hostile subject / sender / snippet /
 *     filename lands as TEXT; the body reaches the page only as the srcdoc of
 *     a sandboxed iframe, sanitized.
 *   - Calls: the list never asks for bodies; a thread opens by thread_key (or
 *     by message for threadless mail); opening marks every unread copy read in
 *     ONE bulk call; attachments ride apiSend's blob transport (the part route
 *     needs the JWT header — a bare link would 401).
 *   - Views: the default view is applied on boot; Save view sends the current
 *     mailbox set + filters; every list call is fully explicit (mailbox_ids
 *     + every toggle), so it is what the screen shows.
 *   - Mailbox picker (review follow-up): any combination of readable boxes;
 *     a view whose boxes were all revoked shows nothing, never everything.
 *   - Mailbox colour (v3): each box's STORED colour (mailboxes.color) through
 *     YCMailboxColor.variants() — per-theme legible values on the row stripe,
 *     its chip, the picker and the thread; no colour = muted grey.
 *   - Mark all read sends the picker set + the on-screen filters, after a
 *     confirm (per-user state, no undo).
 *   - Read state is unmistakable (follow-up): unread rows carry the class +
 *     "Unread." screen-reader text; thread cards say Unread / New and toggle
 *     Mark read ↔ Mark unread against the server and the list row.
 *   - Files vs inline: the server's `inline` decides (a Content-ID alone does
 *     not — Gmail gives every attachment one).
 *   - Hub polish: each file is View (PDF / raster image only, blob RE-TYPED by
 *     the page) · Download · Save to case (the documents upload flow:
 *     upload-link → Dropbox → upload-commit, case picked from suggestions or
 *     search); "Always show from <sender>" per reader; the conversation's
 *     contacts + client cases open the file.
 *   - Add to client (follow-up): outside addresses no contact holds are dashed
 *     chips (3, then "+N more") that call the SHELL's OrphanAdoptDialog with
 *     {earliest: GET /api/mail/first-seen, name}; attaching reloads the strip
 *     (never a stale conversation's); outside the shell it says so.
 *   - Client mail / Has files / the case menu (On / Not on a case) ride every
 *     list call explicitly, restore from a view, save, mark-all, read back.
 *   - Rail (desktop, borrowed from the other agent's Comms mockup): views +
 *     mailboxes as lists over the same state as the menus; a view's unread
 *     count only when its filters narrow nothing but unread; "Unsaved
 *     changes" → Save as view / Update the active one. Filter chips are
 *     pressed buttons; Inbox | All folders is one choice; a row a mailbox
 *     sent reads "To: <recipient>"; the Email tab carries the unread total.
 *   - Phone tab rendered and disabled; the empty hub explains itself.
 *   - Phone widths: opening a message switches to the thread (stacked
 *     navigation, .show-thread), Back returns to the list.
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
const MC = require('../public/js/mailboxColor');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));

const EVIL = '<img src=x onerror="window.top.__pwned=1">';
const MB = [
  { id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 2 },
  { id: 2, address: 'intake@firm.test', display_name: null, color: '#fff3bf', active: true, can_send: false, can_manage: false, inbox_total: 1, inbox_unread: 1 },
];
const ROWS = [
  { id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', thread_key: 'root@x.test', from_addr: `Evil ${EVIL} <evil@x.test>`, to_addrs: 'billing@firm.test', cc_addrs: null, subject: `Subject ${EVIL}`, date: '2026-10-08T14:00:00.000Z', snippet: `snip ${EVIL}`, unread: true, attachment_count: 1, log_id: null, case: null },
  { id: 12, mailbox_id: 2, mailbox_address: 'intake@firm.test', folder: 'INBOX', thread_key: null, from_addr: 'a@b.test', to_addrs: null, cc_addrs: null, subject: 'Threadless', date: '2026-10-07T14:00:00.000Z', snippet: null, unread: false, attachment_count: 0, log_id: 5, case: { case_id: 'CaseA1', case_number: '26-11111' } },
];
const THREAD = {
  thread_key: 'root@x.test', subject: `Subject ${EVIL}`, truncated: false,
  messages: [{
    id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', message_id: 'root@x.test', thread_key: 'root@x.test',
    from_addr: `Evil ${EVIL} <evil@x.test>`, to_addrs: 'billing@firm.test', cc_addrs: null, subject: `Subject ${EVIL}`,
    date: '2026-10-08T14:00:00.000Z', snippet: 'snip',
    body_text: 'plain', body_html: `<p>Hello</p><script>window.top.__pwned=2</script><img src="https://track.test/p.gif"><img src="cid:logo@x">${EVIL}`,
    // `inline` is the server's call (mailReadService.markInline: an image the body draws by cid:);
    // the Gmail-style PDF carries a Content-ID too and is still a FILE
    attachments: [
      { part: '2', filename: `bill ${EVIL}.pdf`, size: 2048, mime: 'application/pdf', cid: 'f_mv06z1bd0', inline: false },
      { part: '3', filename: 'logo.png', size: 10, mime: 'image/png', cid: 'logo@x', inline: true },
      { part: '4', filename: 'photo.jpg', size: 20, mime: 'image/jpeg', cid: 'f_photo', inline: false }, // attached, not drawn
    ],
    unread: true, log_id: null, case: null,
    copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', unread: true }, { id: 31, mailbox_id: 2, mailbox_address: 'intake@firm.test', folder: 'INBOX', unread: true }],
  }],
};

async function boot({ handler, width = 1024 } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  window.firmData = { firmTimezone: 'America/Detroit' };
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null, headers = {}, opts = {}) => {
    calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)), opts });
    return handler(url, method, payload, opts);
  };
  window.addFile = (...a) => calls.push({ addFile: a });
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [PURIFY, RENDER, COLOR, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors };
}

/** Filter chips are buttons; aria-pressed is their state. */
const on = (doc, id) => doc.getElementById(id).getAttribute('aria-pressed') === 'true';

// Fresh copies per response: the pane mutates what it is handed (read flags),
// and a shared fixture would leak one test's clicks into the next.
const fresh = (v) => JSON.parse(JSON.stringify(v));
function standard(over = {}) {
  return (url, method, payload, opts) => {
    if (over[`${method} ${url}`]) return over[`${method} ${url}`](payload, opts);
    if (url === '/api/mail/mailboxes') return { mailboxes: fresh(MB), viewer: { su: true, role: null } };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: fresh(ROWS), next_cursor: null };
    if (url === '/api/mail/threads/root%40x.test') return fresh(THREAD);
    if (url === '/api/mail/messages/12') return { thread_key: null, subject: 'Threadless', messages: [{ ...ROWS[1], body_text: 'only text', body_html: null, attachments: [], copies: [{ id: 12, mailbox_id: 2, folder: 'INBOX', unread: false }] }] };
    if (url === '/api/mail/read' && method === 'POST') return { marked: (payload.ids || []).length };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [] };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

describe('comms hub pane', () => {
  test('boots: Phone tab disabled, mailboxes + views + list loaded, no bodies asked for', async () => {
    const { doc, calls, errors } = await boot({ handler: standard() });
    expect(errors).toEqual([]);
    const phone = doc.getElementById('tab-phone');
    expect(phone.disabled).toBe(true);
    expect(phone.getAttribute('title')).toMatch(/phone slice/i);
    expect(calls.map((c) => c.url)).toEqual(['/api/mail/mailboxes', '/api/mail/views', '/api/mail/messages']);
    expect(doc.querySelectorAll('#msg-list .msg')).toHaveLength(2);
    expect(doc.querySelector('#msg-list .msg').classList.contains('unread')).toBe(true);
    // mailbox chips because two boxes are readable; the case chip on row 2
    expect(doc.querySelectorAll('#msg-list .msg')[1].querySelector('.chip.case').textContent).toContain('26-11111');
  });

  test('hostile envelope fields render as TEXT — no element is created from them', async () => {
    const { window, doc } = await boot({ handler: standard() });
    const row = doc.querySelector('#msg-list .msg');
    expect(row.querySelector('.subject').textContent).toBe(`Subject ${EVIL}`);
    expect(row.querySelector('img')).toBeNull();
    expect(doc.querySelectorAll('img').length).toBe(0);
    expect(window.__pwned).toBeUndefined();
  });

  test('opening a message: thread by key, ONE bulk mark-read of every unread copy, body only in a sandboxed srcdoc', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    expect(calls.find((c) => c.url === '/api/mail/threads/root%40x.test')).toBeTruthy();
    const reads = calls.filter((c) => c.url === '/api/mail/read');
    expect(reads).toEqual([expect.objectContaining({ method: 'POST', payload: { ids: [11, 31] } })]);
    const frames = doc.querySelectorAll('iframe');
    expect(frames).toHaveLength(1);
    const f = frames[0];
    expect(f.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
    expect(f.srcdoc).toMatch(/^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/);
    expect(f.srcdoc).toContain('<p>Hello</p>');
    expect(f.srcdoc).not.toMatch(/<script|onerror|track\.test/);
    // the hostile header and filename stay text in the PARENT document
    expect(doc.querySelector('.mfrom').textContent).toBe(`Evil ${EVIL} <evil@x.test>`);
    expect(doc.querySelector('.att .nm').textContent).toBe(`bill ${EVIL}.pdf`);
    expect([...doc.querySelectorAll('img')]).toEqual([]);
    expect(window.__pwned).toBeUndefined();
    // privacy notice offers to load the hidden image; the inline (cid) part is not listed as a file
    expect(doc.querySelector('.notice').textContent).toMatch(/Images hidden.*2 remote/); // the tracker + the relative src
    expect(doc.querySelectorAll('.att')).toHaveLength(2);
    // the row lost its unread marker
    expect(doc.querySelector('#msg-list .msg').classList.contains('unread')).toBe(false);
  });

  test('threadless mail opens by message id', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    doc.querySelectorAll('#msg-list .msg')[1].click();
    await tick(window, 80);
    expect(calls.find((c) => c.url === '/api/mail/messages/12' && c.method === 'GET')).toBeTruthy();
    const f = doc.querySelector('iframe');
    expect(f.srcdoc).toContain('<pre>only text</pre>');
  });

  test('"Show images" re-renders with remote allowed and fetches inline images through the part route (blob)', async () => {
    const blobs = [];
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mailboxes/1/messages/11/parts/3': (p, opts) => { blobs.push(opts); return new window.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }); },
      }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('.notice button').click();
    await tick(window, 120);
    expect(blobs).toEqual([{ responseType: 'blob' }]);
    // only the image the body draws — the attached photo (a Content-ID, not inline) is not fetched for the body
    expect(calls.filter((c) => /\/parts\//.test(c.url)).map((c) => c.url)).toEqual(['/api/mailboxes/1/messages/11/parts/3']);
    const f = doc.querySelector('iframe');
    expect(f.srcdoc).toContain("img-src data: https: http:");
    expect(f.srcdoc).toContain('src="https://track.test/p.gif"');
    expect(f.srcdoc).not.toMatch(/<script/);
    expect(doc.querySelector('.notice')).toBeNull();
    expect(calls.filter((c) => /\/parts\//.test(c.url)).every((c) => c.opts && c.opts.responseType === 'blob')).toBe(true);
  });

  test('attachments download through apiSend\'s blob transport, never a bare link', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/mailboxes/1/messages/11/parts/2': () => new window.Blob(['%PDF'], { type: 'application/pdf' }) }),
    });
    window.URL.createObjectURL = () => 'blob:https://app.4lsg.com/x';
    window.URL.revokeObjectURL = () => {};
    const downloads = [];
    window.HTMLAnchorElement.prototype.click = function () { downloads.push([this.getAttribute('href'), this.getAttribute('download')]); };
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('.att .att-dl').click();
    await tick(window, 40);
    const c = calls.find((x) => x.url === '/api/mailboxes/1/messages/11/parts/2');
    expect(c).toMatchObject({ method: 'GET', opts: { responseType: 'blob' } });
    expect(downloads).toEqual([['blob:https://app.4lsg.com/x', `bill ${EVIL}.pdf`]]);
    expect(doc.querySelector('a[href*="/api/"]')).toBeNull();
  });

  test('read vs unread in the list: class + screen-reader text, and the CSS gives unread four cues', async () => {
    const { window, doc } = await boot({ handler: standard() });
    const rows = [...doc.querySelectorAll('#msg-list .msg')];
    expect(rows.map((r) => [r.classList.contains('unread'), r.querySelector('.sr-state').textContent])).toEqual([[true, 'Unread. '], [false, '']]);
    // the rules themselves (jsdom does not cascade the pane's <style>; real Chrome is checked in the screenshot pass)
    for (const rule of [
      '.msg.unread { background: var(--surface); }',
      '.msg .from, .msg .subject { color: var(--text-2); }',
      '.msg.unread .from, .msg.unread .subject, .msg.unread .date { font-weight: 700; color: var(--text); }',
      'background: var(--accent-2); }',
    ]) expect(HTML).toContain(rule);
    expect(HTML.indexOf('.msg.unread { background')).toBeLessThan(HTML.indexOf('.msg:hover { background'));
    expect(HTML.indexOf('.msg:hover { background')).toBeLessThan(HTML.indexOf('.msg.selected { background'));
    rows[0].click();
    await tick(window, 80);
    expect(rows[0].querySelector('.sr-state').textContent).toBe('');
  });

  test('thread cards: Unread → New once opened; Mark unread / Mark read toggle the card, the row and the server', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({ 'DELETE /api/mail/messages/11/read': () => ({ id: 11, unread: true }) }),
    });
    const row = () => doc.querySelector('#msg-list .msg[data-id="11"]');
    row().click();
    await tick(window, 80);
    const card = doc.querySelector('.mcard[data-id="11"]');
    const state = () => [card.querySelector('.mstate').textContent, card.querySelector('.mstate').classList.contains('unread'),
      card.classList.contains('is-unread'), card.classList.contains('is-new'), card.querySelector('.read-toggle').textContent.trim()];
    // it WAS unread as the conversation opened: marked read on open, still flagged New
    expect(state()).toEqual(['New', false, false, true, 'Mark unread']);
    card.querySelector('.read-toggle').click();
    await tick(window, 40);
    expect(calls.some((c) => c.url === '/api/mail/messages/11/read' && c.method === 'DELETE')).toBe(true);
    expect(state()).toEqual(['Unread', true, true, false, 'Mark read']);
    expect([row().classList.contains('unread'), row().querySelector('.sr-state').textContent]).toEqual([true, 'Unread. ']);
    card.querySelector('.read-toggle').click();
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/read').pop().payload).toEqual({ ids: [11] });
    expect(state()).toEqual(['New', false, false, true, 'Mark unread']);
    expect(row().classList.contains('unread')).toBe(false);
  });

  test('a longer conversation: every card that was unread flips to New once the open\'s mark-read lands; read ones show nothing', async () => {
    const thread = JSON.parse(JSON.stringify(THREAD));
    const older = { ...JSON.parse(JSON.stringify(thread.messages[0])), id: 9, message_id: 'older@x.test', date: '2026-10-07T09:00:00.000Z', unread: false, attachments: [],
      copies: [{ id: 9, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', unread: false }] };
    const mid = { ...JSON.parse(JSON.stringify(thread.messages[0])), id: 10, message_id: 'mid@x.test', date: '2026-10-07T12:00:00.000Z', unread: true, attachments: [],
      copies: [{ id: 10, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', unread: true }] };
    thread.messages = [older, mid, thread.messages[0]];
    const { window, doc, calls, errors } = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': () => JSON.parse(JSON.stringify(thread)) }) });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    expect(calls.filter((c) => c.url === '/api/mail/read').pop().payload).toEqual({ ids: [10, 11, 31] });
    expect([...doc.querySelectorAll('.mcard')].map((c) => [c.dataset.id, c.querySelector('.mstate').textContent])).toEqual([['9', ''], ['10', 'New'], ['11', 'New']]);
    expect(doc.getElementById('toast').textContent).not.toMatch(/Couldn't/);
    expect(errors).toEqual([]);
  });

  test('a read message opened again shows no pill', async () => {
    const { window, doc } = await boot({ handler: standard() });
    doc.querySelectorAll('#msg-list .msg')[1].click();
    await tick(window, 80);
    const card = doc.querySelector('.mcard');
    expect([card.querySelector('.mstate').textContent, card.classList.contains('is-new'), card.querySelector('.read-toggle').textContent.trim()])
      .toEqual(['', false, 'Mark unread']);
  });

  test('a PDF with a Content-ID (every Gmail attachment has one) is a FILE: listed, and counted on the card head; the drawn image is not', async () => {
    const { window, doc } = await boot({ handler: standard() });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    expect([...doc.querySelectorAll('.att .nm')].map((n) => n.textContent)).toEqual([`bill ${EVIL}.pdf`, 'photo.jpg']);
    expect(doc.querySelector('.mcard .mclip').textContent.trim()).toBe('2');
    expect(doc.querySelector('.mcard .mclip').title).toBe('2 attachments');
  });

  test('Mark read after Mark unread clears the copy that was marked — even when the card\'s message id is another copy', async () => {
    // the thread collapses copies 11 (box 1, the opened row) and 31 (box 2, primary — it carries the log row)
    const thread = JSON.parse(JSON.stringify(THREAD));
    thread.messages[0].id = 31;
    thread.messages[0].copies = [{ id: 31, mailbox_id: 2, mailbox_address: 'intake@firm.test', folder: 'INBOX', unread: false }, { id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', unread: true }];
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/mail/threads/root%40x.test': () => JSON.parse(JSON.stringify(thread)), 'DELETE /api/mail/messages/11/read': () => ({ id: 11, unread: true }) }),
    });
    doc.querySelector('#msg-list .msg[data-id="11"]').click();
    await tick(window, 80);
    expect(calls.filter((c) => c.url === '/api/mail/read').pop().payload).toEqual({ ids: [11] });
    const btn = doc.querySelector('.mcard .read-toggle');
    btn.click(); // Mark unread → the opened copy (11), not the card's id (31)
    await tick(window, 40);
    expect(calls.some((c) => c.url === '/api/mail/messages/11/read' && c.method === 'DELETE')).toBe(true);
    btn.click(); // Mark read → that same copy
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/read').pop().payload).toEqual({ ids: [11] });
    expect(doc.querySelector('#msg-list .msg[data-id="11"]').classList.contains('unread')).toBe(false);
  });

  // ── hub polish: attachments, viewer, save to case, trusted senders, related ──
  const blobCapture = (window) => {
    const made = [];
    window.URL.createObjectURL = (b) => { made.push(b); return `blob:https://app.4lsg.com/${made.length}`; };
    const revoked = [];
    window.URL.revokeObjectURL = (u) => revoked.push(u);
    return { made, revoked };
  };
  const withAtts = (atts, over = {}) => {
    const t = fresh(THREAD);
    Object.assign(t.messages[0], { attachments: atts, ...over });
    return t;
  };

  test('each file: the name views a PDF / image (else downloads); View only where viewable; Download and Save to case always', async () => {
    const thread = withAtts([
      { part: '2', filename: 'Untitled.pdf', size: 5, mime: 'application/pdf', cid: 'f_1', inline: false },
      { part: '3', filename: 'Exhibit A.docx', size: 5, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', cid: null, inline: false },
      { part: '4', filename: 'scan.PDF', size: 5, mime: 'application/octet-stream', cid: null, inline: false },        // generic mime, .pdf name
      { part: '5', filename: 'evil.pdf', size: 5, mime: 'text/html', cid: null, inline: false },                       // HTML dressed as a PDF
      { part: '6', filename: 'logo.svg', size: 5, mime: 'image/svg+xml', cid: null, inline: false },                   // script-capable image
    ]);
    const { window, doc } = await boot({ handler: standard({ 'GET /api/mail/threads/root%40x.test': () => fresh(thread) }) });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    const rows = [...doc.querySelectorAll('.att')].map((r) => [r.dataset.part, !!r.querySelector('.att-view'), !!r.querySelector('.att-dl'), !!r.querySelector('.att-save')]);
    expect(rows).toEqual([['2', true, true, true], ['3', false, true, true], ['4', true, true, true], ['5', false, true, true], ['6', false, true, true]]);
  });

  test('viewer: the blob is re-typed by the page (never trusted), PDFs get an iframe + New tab, images an <img>; closing revokes', async () => {
    const thread = withAtts([
      { part: '2', filename: 'Untitled.pdf', size: 5, mime: 'application/pdf', cid: 'f_1', inline: false },
      { part: '4', filename: 'scan.pdf', size: 5, mime: 'application/octet-stream', cid: null, inline: false },
      { part: '7', filename: 'photo.jpg', size: 5, mime: 'image/jpeg', cid: 'f_p', inline: false },
    ]);
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': () => fresh(thread),
        'GET /api/mailboxes/1/messages/11/parts/2': () => new window.Blob(['<script>x</script>'], { type: 'text/html' }),
        'GET /api/mailboxes/1/messages/11/parts/4': () => new window.Blob(['%PDF'], { type: 'application/octet-stream' }),
        'GET /api/mailboxes/1/messages/11/parts/7': () => new window.Blob(['jpg'], { type: 'image/jpeg' }),
      }),
    });
    const { made, revoked } = blobCapture(window);
    const opened = [];
    window.open = (...a) => { opened.push(a); return null; };
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('.att[data-part="2"] .att-name').click();   // the name views a PDF
    await tick(window, 40);
    expect(calls.find((c) => c.url === '/api/mailboxes/1/messages/11/parts/2').opts).toEqual({ responseType: 'blob' });
    expect(made.map((b) => b.type)).toEqual(['application/pdf']);  // the server said text/html: ignored
    const frame = doc.querySelector('#viewer-body iframe');
    expect([frame.getAttribute('src'), doc.getElementById('viewer-tab').hidden, doc.getElementById('viewer-title').textContent]).toEqual(['blob:https://app.4lsg.com/1', false, 'Untitled.pdf']);
    doc.getElementById('viewer-tab').click();
    expect(opened).toEqual([['blob:https://app.4lsg.com/1', '_blank', 'noopener']]);
    doc.getElementById('viewer-close').click();
    expect(revoked).toEqual([]);                                   // a tab is reading it: revoked later, not now
    doc.querySelector('.att[data-part="4"] .att-view').click();
    await tick(window, 40);
    expect(made[1].type).toBe('application/pdf');
    doc.querySelector('.att[data-part="7"] .att-view').click();    // opening another closes (and revokes) the first
    await tick(window, 40);
    expect(revoked).toEqual(['blob:https://app.4lsg.com/2']);
    expect([made[2].type, doc.querySelector('#viewer-body img').getAttribute('src'), doc.getElementById('viewer-tab').hidden]).toEqual(['image/jpeg', 'blob:https://app.4lsg.com/3', true]);
    doc.getElementById('viewer-close').click();
    expect(revoked).toEqual(['blob:https://app.4lsg.com/2', 'blob:https://app.4lsg.com/3']);
    expect(doc.getElementById('viewer-backdrop').classList.contains('open')).toBe(false);
  });

  test('save to case: suggestions (the linked case, then the conversation\'s client cases) → part blob → upload-link → Dropbox → upload-commit', async () => {
    const thread = withAtts([{ part: '2', filename: 'Untitled.pdf', size: 5, mime: 'application/pdf', cid: 'f_1', inline: false }],
      { case: { case_id: 'CaseA1', case_number: '26-11111' } });
    const xhrs = [];
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': () => fresh(thread),
        'GET /api/mail/messages/11/related': () => ({ contacts: [{ contact_id: 500, name: 'Doe, Jane', kind: 'person', emails: ['jane@client.test'], role: 'from', cases: [
          { case_id: 'CaseA1', case_number: '26-11111', case_stage: 'Filed' }, { case_id: 'CaseB2', case_number: '26-22222', case_type: 'BK', case_stage: 'Open' }] }] }),
        'GET /api/mailboxes/1/messages/11/parts/2': () => new window.Blob(['%PDF-1.7'], { type: 'application/pdf' }),
        'POST /api/documents/upload-link': () => ({ link: 'https://content.dropboxapi.com/apitul/1/abc', path: '/Cases/B2/Untitled.pdf', ticket: 'tkt', placement: 'case' }),
        'POST /api/documents/upload-commit': () => ({ document: { id: 9 }, link_type: 'case', link_id: 'CaseB2' }),
      }),
    });
    window.XMLHttpRequest = class {
      constructor() { this.upload = {}; this.headers = {}; xhrs.push(this); }
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(k, v) { this.headers[k] = v; }
      send(body) { this.body = body; this.status = 200; this.responseText = JSON.stringify({ id: 'id:dbx123' }); setTimeout(() => this.onload(), 0); }
    };
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('.att .att-save').click();
    expect(doc.getElementById('case-title').textContent).toBe('Save “Untitled.pdf” to a case');
    const sugg = [...doc.querySelectorAll('#case-sugg li')];
    expect(sugg.map((li) => li.querySelector('.l1').textContent)).toEqual(['26-11111', '26-22222Open']);
    expect(doc.getElementById('case-sugg-wrap').hidden).toBe(false);
    sugg[1].click();
    await tick(window, 80);
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(false);
    expect(calls.find((c) => c.url === '/api/documents/upload-link').payload).toEqual({ case_id: 'CaseB2', filename: 'Untitled.pdf' });
    expect(xhrs.map((x) => [x.method, x.url, x.headers['Content-Type'], x.body && x.body.size])).toEqual([['POST', 'https://content.dropboxapi.com/apitul/1/abc', 'application/octet-stream', 8]]);
    expect(calls.find((c) => c.url === '/api/documents/upload-commit').payload).toEqual({ ticket: 'tkt', external_id: 'id:dbx123' });
    expect(doc.getElementById('toast').textContent).toBe('Saved Untitled.pdf to 26-22222');
    // and nothing was case-LINKED by a save
    expect(calls.some((c) => /case-link/.test(c.url))).toBe(false);
  });

  test('images: "Always show from <sender>" trusts for this reader and re-renders; Stop hides them again', async () => {
    const thread = withAtts(THREAD.messages[0].attachments, { from_email: 'evil@x.test', images_trusted: false });
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': () => fresh(thread),
        'POST /api/mail/image-senders': (p) => ({ address: p.address }),
        'DELETE /api/mail/image-senders/evil%40x.test': () => ({ address: 'evil@x.test', removed: 1 }),
        'GET /api/mailboxes/1/messages/11/parts/3': () => new window.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    const trust = doc.querySelector('.notice .trust-btn');
    expect(trust.textContent).toBe('Always show from evil@x.test');
    trust.click();
    await tick(window, 80);
    expect(calls.find((c) => c.url === '/api/mail/image-senders' && c.method === 'POST').payload).toEqual({ address: 'evil@x.test' });
    expect(doc.querySelector('.notice')).toBeNull();
    expect(doc.querySelector('iframe').srcdoc).toContain('img-src data: https: http:');
    expect(calls.some((c) => c.url === '/api/mailboxes/1/messages/11/parts/3')).toBe(true);   // inline image fetched too
    expect(doc.querySelector('.trustline').textContent).toMatch(/you trust evil@x\.test/);
    doc.querySelector('.trustline .untrust-btn').click();
    await tick(window, 80);
    expect(calls.some((c) => c.url === '/api/mail/image-senders/evil%40x.test' && c.method === 'DELETE')).toBe(true);
    expect(doc.querySelector('.notice .trust-btn')).not.toBeNull();
    expect(doc.querySelector('iframe').srcdoc).toContain("img-src data:;");
  });

  test('a trusted sender\'s mail opens with images shown (remote allowed, inline fetched) — no click', async () => {
    const thread = withAtts(THREAD.messages[0].attachments, { from_email: 'evil@x.test', images_trusted: true });
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/threads/root%40x.test': () => fresh(thread),
        'GET /api/mailboxes/1/messages/11/parts/3': () => new window.Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
      }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 120);
    expect(doc.querySelector('.notice')).toBeNull();
    expect(doc.querySelector('iframe').srcdoc).toContain('src="https://track.test/p.gif"');
    expect(calls.filter((c) => c.url === '/api/mailboxes/1/messages/11/parts/3')).toHaveLength(1);  // once, not a loop
  });

  test('related: contacts and their client cases open the file; nothing related → no strip', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/messages/11/related': () => ({ contacts: [
          { contact_id: 500, name: 'Doe, Jane', kind: 'person', emails: ['jane@client.test'], role: 'from', cases: [{ case_id: 'CaseB2', case_number: '26-22222', case_stage: 'Open' }] },
          { contact_id: 600, name: 'Acme Trustee LLC', kind: 'org', emails: ['t@trustee.test'], role: 'to', cases: [] },
        ], unmatched: [{ email: 'new@person.test', name: null, role: 'to' }] }),
        'GET /api/mail/messages/12/related': () => new Promise(() => {}), // still loading
      }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    expect(calls.some((c) => c.url === '/api/mail/messages/11/related')).toBe(true);
    const strip = doc.getElementById('thread-related');
    expect([strip.hidden, strip.textContent]).toEqual([false, 'In this conversation:Doe, Jane26-22222 · OpenAcme Trustee LLCAdd to a client:new@person.test']);
    strip.querySelector('.chip.person').click();
    strip.querySelector('.chip.case').click();
    expect(calls.filter((c) => c.addFile).map((c) => c.addFile)).toEqual([['Doe, Jane', 'client', '500'], ['26-22222', 'case', 'CaseB2']]);
    // the link-to-case picker offers the same cases first
    [...doc.querySelectorAll('.mactions button')].find((b) => /Link to case/.test(b.textContent)).click();
    expect([...doc.querySelectorAll('#case-sugg li .l1')].map((x) => x.textContent)).toEqual(['26-22222Open']);
    // another conversation: the previous one's people never linger while its own load
    doc.querySelectorAll('#msg-list .msg')[1].click();
    await tick(window, 80);
    expect([strip.hidden, strip.textContent]).toEqual([true, '']);
  });

  test('add to client: addresses no contact holds are dashed chips (3, then "+N more") that open the shell\'s attach-or-create dialog', async () => {
    let related = { contacts: [], unmatched: [
      { email: 'ann@new.test', name: 'Smith, Ann', role: 'from' },
      { email: 'dee@new.test', name: null, role: 'to' },
      { email: 'bob@new.test', name: 'Bob', role: 'to' },
      { email: 'carl@new.test', name: null, role: 'to' },
    ] };
    let seenFails = false;
    const { window, doc, calls, errors } = await boot({
      handler: standard({
        'GET /api/mail/messages/11/related': () => fresh(related),
        'GET /api/mail/first-seen': (p) => { if (seenFails) throw new Error('boom'); return { address: p.address, first_seen: '2026-02-28' }; },
      }),
    });
    const dialogs = [];
    window.OrphanAdoptDialog = (...a) => { dialogs.push(a); };
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    const strip = doc.getElementById('thread-related');
    expect([strip.hidden, strip.textContent]).toEqual([false, 'Add to a client:Smith, Anndee@new.testBob+1 more']);
    expect([...strip.querySelectorAll('.chip.add')].map((c) => c.title)).toEqual([
      'Add ann@new.test to a client — an existing contact or a new one', 'Add dee@new.test to a client — an existing contact or a new one',
      'Add bob@new.test to a client — an existing contact or a new one']);
    strip.querySelector('.more-adds').click();
    expect(strip.querySelectorAll('.chip.add')).toHaveLength(4);
    expect(strip.querySelector('.more-adds')).toBeNull();
    // click: the first-seen day, then the dialog with the email, the start-date hint and the name
    strip.querySelector('.chip.add').click();
    await tick(window, 40);
    expect(calls.find((c) => c.url === '/api/mail/first-seen')).toMatchObject({ method: 'GET', payload: { address: 'ann@new.test' } });
    expect(dialogs.map(([v, t, fn, o]) => [v, t, typeof fn, o])).toEqual([['ann@new.test', 'email', 'function', { earliest: '2026-02-28', name: 'Smith, Ann' }]]);
    // attached → the strip reloads: Ann is a contact now
    related = { contacts: [{ contact_id: 900, name: 'Smith, Ann', kind: 'person', emails: ['ann@new.test'], role: 'from', cases: [] }], unmatched: related.unmatched.slice(1) };
    const before = calls.filter((c) => c.url === '/api/mail/messages/11/related').length;
    dialogs[0][2]({ action: 'attached', contact_id: 900 });
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/messages/11/related')).toHaveLength(before + 1);
    expect(strip.textContent).toBe('In this conversation:Smith, AnnAdd to a client:dee@new.testBobcarl@new.test'); // still expanded
    // first-seen failing never blocks the dialog (it falls back to the log, then today)
    seenFails = true;
    strip.querySelector('.chip.add').click();
    await tick(window, 40);
    expect(dialogs[1][0]).toBe('dee@new.test');
    expect(dialogs[1][3]).toEqual({ earliest: null, name: '' });
    // a stale callback (another conversation opened meanwhile) does not repaint this one
    doc.querySelectorAll('#msg-list .msg')[1].click();
    await tick(window, 80);
    const n = calls.filter((c) => c.url === '/api/mail/messages/11/related').length;
    dialogs[1][2]({ action: 'created' });
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/mail/messages/11/related')).toHaveLength(n);
    expect(errors).toEqual([]);
  });

  test('add to client outside the shell (no dialog to call) says so instead of failing', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/mail/messages/11/related': () => ({ contacts: [], unmatched: [{ email: 'ann@new.test', name: null, role: 'from' }] }) }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('#thread-related .chip.add').click();
    await tick(window, 20);
    expect(doc.getElementById('toast').textContent).toMatch(/needs the app window/);
    expect(calls.some((c) => c.url === '/api/mail/first-seen')).toBe(false);
  });

  test('client mail / has files / not on a case: ride every list call, restore from a view, save, and read back in words', async () => {
    const views = [{ id: 8, name: 'To file', mailbox_ids: null, filters: { client_only: true, no_case: true }, is_default: true, sort_order: 0 }];
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/views': () => ({ views }),
        'POST /api/mail/views': (p) => ({ view: { id: 9, ...p, mailbox_ids: p.mailbox_ids || null, sort_order: 0 } }),
        'POST /api/mail/read': () => ({ marked: 0 }),
      }),
    });
    expect(['f-client', 'f-files', 'f-hascase', 'f-nocase'].map((id) => on(doc, id))).toEqual([true, false, false, true]);
    expect(calls.find((c) => c.url === '/api/mail/messages').payload).toMatchObject({ client_only: 1, has_files: 0, has_case: 0, no_case: 1 });
    doc.getElementById('f-files').click();
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ client_only: 1, has_files: 1, has_case: 0, no_case: 1 });
    // On a case / Not on a case are exclusive: pressing one releases the other
    doc.getElementById('f-hascase').click();
    await tick(window);
    expect([on(doc, 'f-hascase'), on(doc, 'f-nocase')]).toEqual([true, false]);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ has_case: 1, no_case: 0 });
    doc.getElementById('f-hascase').click();               // …and pressing it again is "any"
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ has_case: 0, no_case: 0 });
    doc.getElementById('f-nocase').click();
    await tick(window);
    doc.getElementById('views-btn').click();
    expect(doc.querySelector('#vw-list .vw-sum').textContent).toBe('All mailboxes— client mail, not on a case');
    doc.getElementById('vw-name').value = 'Docs to file';
    doc.getElementById('vw-save').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views' && c.method === 'POST').payload)
      .toEqual({ name: 'Docs to file', filters: { client_only: true, has_files: true, no_case: true }, is_default: false });
    // mark-all carries them too
    window.confirm = () => true;
    doc.getElementById('readall-btn').click();
    await tick(window, 40);
    expect(calls.find((c) => c.url === '/api/mail/read').payload).toEqual({ all: true, filters: { client_only: true, has_files: true, no_case: true } });
    // a view without them clears the controls
    doc.getElementById('view-sel').value = '';
    doc.getElementById('view-sel').dispatchEvent(new window.Event('change'));
    expect(['f-client', 'f-files', 'f-hascase', 'f-nocase'].map((id) => on(doc, id))).toEqual([false, false, false, false]);
  });

  test('rail: views and mailboxes as lists over the SAME state as the menus — counts only when honest, Unsaved changes → Save / Update', async () => {
    let views = [
      { id: 4, name: 'Billing unread', mailbox_ids: [1], filters: { unread_only: true }, is_default: false, sort_order: 0 },
      { id: 5, name: 'Client docs', mailbox_ids: null, filters: { client_only: true, has_files: true }, is_default: true, sort_order: 1 },
    ];
    const { window, doc, calls, errors } = await boot({
      handler: standard({
        'GET /api/mail/mailboxes': () => ({ mailboxes: [{ ...fresh(MB[0]), can_manage: true }, fresh(MB[1])], viewer: { su: false, role: null } }),
        'GET /api/mail/views': () => ({ views: fresh(views) }),
        'PATCH /api/mail/views/5': (p) => { views = views.map((v) => (v.id === 5 ? { ...v, ...p } : v)); return { view: views[1] }; },
      }),
    });
    const lastList = () => calls.filter((c) => c.url === '/api/mail/messages').pop().payload;
    const vitems = () => [...doc.querySelectorAll('#rail-views .vitem')];
    const bitems = () => [...doc.querySelectorAll('#rail-boxes .bitem')];
    // All mail = every box's INBOX unread; a view narrowing only by unread gets its boxes' count; a client/files view none
    expect(vitems().map((b) => b.textContent)).toEqual(['All mail3', 'Billing unread2', 'Client docs ★']);
    expect(vitems().map((b) => b.classList.contains('on'))).toEqual([false, false, true]); // the default view is active
    expect(doc.getElementById('rail-dirty').textContent).toBe('');
    expect(doc.getElementById('tab-email-n').textContent).toBe('3');
    // one row per readable box: ticked, its colour, name + address, access, unread
    expect(bitems().map((b) => [b.getAttribute('aria-pressed'), b.querySelector('.nm').textContent, b.querySelector('.acc').textContent, (b.querySelector('.cnt') || {}).textContent]))
      .toEqual([['true', 'Billingbilling@firm.test', 'R·S·M', '2'], ['true', 'intake@firm.test', 'R', '1']]);
    expect(bitems()[1].querySelector('.mdot').style.getPropertyValue('--mbc-l')).toBe(MC.variants('#fff3bf').light);
    // untick a box: the list narrows (same as the picker), the picker agrees, the view is now "unsaved"
    bitems()[1].click();
    await tick(window);
    expect(lastList()).toMatchObject({ mailbox_ids: '1', client_only: 1, has_files: 1 });
    expect(doc.querySelector('#mb-panel input[data-id="2"]').checked).toBe(false);
    expect(bitems().map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(vitems().some((b) => b.classList.contains('on'))).toBe(false);
    expect(doc.getElementById('rail-dirty').textContent).toBe('Unsaved changesSave as viewUpdate “Client docs”');
    // Update writes the screen into the active view; the rail is clean again
    doc.getElementById('rail-update').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views/5' && c.method === 'PATCH').payload).toEqual({ mailbox_ids: [1], filters: { client_only: true, has_files: true } });
    expect(doc.getElementById('rail-dirty').textContent).toBe('');
    expect(vitems()[2].classList.contains('on')).toBe(true);
    // All mail = no view: every box, no filters
    vitems()[0].click();
    await tick(window);
    expect(lastList()).not.toHaveProperty('mailbox_ids');
    expect(lastList()).toMatchObject({ client_only: 0, has_files: 0, unread_only: 0, all_folders: 0 });
    expect(vitems()[0].classList.contains('on')).toBe(true);
    expect(doc.getElementById('view-sel').value).toBe('');
    // a view from the rail = the same as picking it in the menu
    vitems()[1].click();
    await tick(window);
    expect(lastList()).toMatchObject({ mailbox_ids: '1', unread_only: 1 });
    expect(doc.getElementById('view-sel').value).toBe('4');
    // a filter change makes it unsaved; Save as view opens the views dialog on the name
    doc.getElementById('f-unread').click();
    await tick(window);
    expect(doc.getElementById('rail-dirty').textContent).toBe('Unsaved changesSave as viewUpdate “Billing unread”');
    doc.getElementById('rail-save').click();
    expect(doc.getElementById('views-backdrop').classList.contains('open')).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById('vw-name'));
    doc.getElementById('views-close').click();
    doc.getElementById('rail-manage').click();
    expect(doc.getElementById('views-backdrop').classList.contains('open')).toBe(true);
    expect(errors).toEqual([]);
  });

  test('Inbox | All folders is one choice; mail a mailbox SENT names its recipient, not the firm', async () => {
    const sent = { ...ROWS[1], id: 13, folder: '[Gmail]/Sent Mail', from_addr: 'Billing <billing@firm.test>', to_addrs: '"Doe, Jane" <jane@x.test>, b@y.test', thread_key: null };
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/mail/messages': () => ({ messages: fresh([ROWS[0], sent]), next_cursor: null }) }) });
    const from = [...doc.querySelectorAll('#msg-list .msg .from')];
    expect(from.map((f) => [f.textContent, f.title])).toEqual([
      ['Evil <img src=x onerror="window.top.__pwned=1">', ROWS[0].from_addr],
      ['To: Doe, Jane', 'To: "Doe, Jane" <jane@x.test>, b@y.test'],
    ]);
    const lastList = () => calls.filter((c) => c.url === '/api/mail/messages').pop().payload;
    expect([on(doc, 'f-inbox'), on(doc, 'f-folders')]).toEqual([true, false]);
    doc.getElementById('f-folders').click();
    await tick(window);
    expect([on(doc, 'f-inbox'), on(doc, 'f-folders'), lastList().all_folders]).toEqual([false, true, 1]);
    const n = calls.length;
    doc.getElementById('f-folders').click();               // already on: nothing to do
    await tick(window);
    expect(calls.length).toBe(n);
    doc.getElementById('f-inbox').click();
    await tick(window);
    expect([on(doc, 'f-inbox'), on(doc, 'f-folders'), lastList().all_folders]).toEqual([true, false, 0]);
  });

  test('mark unread → DELETE …/read for the copy the reader opened', async () => {
    const { window, doc, calls } = await boot({ handler: standard({ 'DELETE /api/mail/messages/11/read': () => ({ id: 11, unread: true }) }) });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    [...doc.querySelectorAll('.mactions button')].find((b) => /Mark unread/.test(b.textContent)).click();
    await tick(window, 40);
    expect(calls.some((c) => c.url === '/api/mail/messages/11/read' && c.method === 'DELETE')).toBe(true);
    expect(doc.querySelector('#msg-list .msg').classList.contains('unread')).toBe(true);
  });

  test('case link: search, pick, POST, chip appears', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/cases/search': () => ({ cases: [{ case_id: 'CaseA1', case_number: '26-11111', case_number_full: '26-11111-tjt', case_type: 'BK', primary_contact_name: 'Doe' }] }),
        'POST /api/mail/messages/11/case-link': () => ({ id: 11, log_id: 77, log_created: true, case: { case_id: 'CaseA1', case_number: '26-11111-tjt' } }),
      }),
    });
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    [...doc.querySelectorAll('.mactions button')].find((b) => /Link to case/.test(b.textContent)).click();
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(true);
    const q = doc.getElementById('case-q');
    q.value = '26-111';
    q.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    expect(calls.find((c) => c.url === '/api/cases/search')).toMatchObject({ payload: { q: '26-111', limit: 20 } });
    doc.querySelector('#case-results li').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/messages/11/case-link')).toMatchObject({ method: 'POST', payload: { case_id: 'CaseA1' } });
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(false);
    expect(doc.querySelector('#msg-list .msg .chip.case').textContent).toContain('26-11111-tjt');
    expect(doc.querySelector('.mactions .chip.case').textContent).toContain('26-11111-tjt');
  });

  test('default view applied on boot; toggles ride every list call; Save view sends the current filters', async () => {
    const views = [{ id: 4, name: 'Unread billing', mailbox_ids: [1], filters: { unread_only: true, q: 'plan' }, is_default: true, sort_order: 0 }];
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/views': () => ({ views }),
        'POST /api/mail/views': (p) => ({ view: { id: 5, ...p, mailbox_ids: p.mailbox_ids || null, sort_order: 0 } }),
      }),
    });
    const first = calls.find((c) => c.url === '/api/mail/messages');
    expect(first.payload).toEqual({ mailbox_ids: '1', unread_only: 1, q: 'plan', client_only: 0, has_files: 0, has_case: 0, no_case: 0, all_folders: 0, from_domain: '' });
    expect(on(doc, 'f-unread')).toBe(true);
    expect(doc.getElementById('mb-label').textContent).toBe('Billing — billing@firm.test (2)');
    doc.getElementById('f-hascase').click();
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).toMatchObject({ mailbox_ids: '1', unread_only: 1, has_case: 1 });
    doc.getElementById('views-btn').click();
    doc.getElementById('vw-name').value = 'Mine';
    doc.getElementById('vw-save').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views' && c.method === 'POST').payload)
      .toEqual({ name: 'Mine', filters: { q: 'plan', unread_only: true, has_case: true }, is_default: false, mailbox_ids: [1] });
  });

  test('mailbox picker: any combination of boxes rides mailbox_ids; All clears it', async () => {
    const MB3 = [...MB, { id: 3, address: 'shoshana@mdbl.test', display_name: null, active: true, can_send: true, can_manage: false, inbox_total: 4, inbox_unread: 4 }];
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/mail/mailboxes': () => ({ mailboxes: MB3, viewer: { su: true, role: null } }) }) });
    const btn = doc.getElementById('mb-btn');
    const panel = doc.getElementById('mb-panel');
    expect([btn.hidden, panel.hidden, doc.getElementById('mb-label').textContent]).toEqual([false, true, 'All mailboxes (7)']);
    btn.click();
    expect([panel.hidden, btn.getAttribute('aria-expanded')]).toEqual([false, 'true']);
    const box = (id) => panel.querySelector(`input[data-id="${id}"]`);
    expect([1, 2, 3].map((id) => box(id).checked)).toEqual([true, true, true]);
    box(2).checked = false;
    box(2).dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload.mailbox_ids).toBe('1,3');
    expect(doc.getElementById('mb-label').textContent).toBe('2 mailboxes (6)');
    expect(btn.title).toBe('billing@firm.test, shoshana@mdbl.test');
    box(3).checked = false;
    box(3).dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload.mailbox_ids).toBe('1');
    const all = panel.querySelector('input:not([data-id])');
    all.checked = true;
    all.dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).not.toHaveProperty('mailbox_ids');
    // unticking the last remaining box = every box again, never an empty scope
    box(1).checked = false; box(1).dispatchEvent(new window.Event('change'));
    box(2).checked = false; box(2).dispatchEvent(new window.Event('change'));
    box(3).checked = false; box(3).dispatchEvent(new window.Event('change'));
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages').pop().payload).not.toHaveProperty('mailbox_ids');
    expect(doc.getElementById('mb-label').textContent).toBe('All mailboxes (7)');
  });

  test('each box is drawn in its STORED colour (per-theme legible values) on the row, its chip, the picker and the thread', async () => {
    const { window, doc } = await boot({ handler: standard() });
    const vars = (el) => [el.style.getPropertyValue('--mbc-l'), el.style.getPropertyValue('--mbc-d')];
    const blue = MC.variants('#2f6fd1');  // clears 3:1 on light as stored; lifted on dark
    const pale = MC.variants('#fff3bf');  // too pale for light: darkened there; as stored on dark
    expect(blue.light).toBe('#2f6fd1');
    expect(blue.dark).not.toBe('#2f6fd1');
    expect(pale.light).not.toBe('#fff3bf');
    expect(pale.dark).toBe('#fff3bf');
    const rows = doc.querySelectorAll('#msg-list .msg');
    expect([...rows].map((r) => [r.classList.contains('boxed'), r.classList.contains('mbc'), ...vars(r)]))
      .toEqual([[true, true, blue.light, blue.dark], [true, true, pale.light, pale.dark]]);
    expect(vars(rows[0].querySelector('.chip.box'))).toEqual([blue.light, blue.dark]);
    expect(vars(rows[0].querySelector('.chip.box .mdot'))).toEqual([blue.light, blue.dark]);
    expect(vars(doc.querySelector('#mb-panel input[data-id="2"]').parentNode.querySelector('.mdot'))).toEqual([pale.light, pale.dark]);
    rows[0].click();
    await tick(window, 80);
    expect([...doc.querySelectorAll('.mcard .cp .mdot')].map(vars)).toEqual([[blue.light, blue.dark], [pale.light, pale.dark]]);
    // the theme switch is CSS: .mbc reads --mbc-l, the dark theme --mbc-d
    expect(HTML).toContain('.mbc { --mbc: var(--mbc-l); }');
    expect(HTML).toContain('html[data-theme="dark"] .mbc { --mbc: var(--mbc-d); }');
    // the colour is the box's data, not its id or position: re-colour the boxes and
    // list them in another order (the summary sorts by address) — the colours follow the boxes
    const swapped = await boot({ handler: standard({ 'GET /api/mail/mailboxes': () => ({ mailboxes: [{ ...MB[1], color: null }, { ...MB[0], color: '#fff3bf' }], viewer: { su: true, role: null } }) }) });
    expect([...swapped.doc.querySelectorAll('#msg-list .msg')].map(vars))
      .toEqual([[pale.light, pale.dark], ['var(--text-muted)', 'var(--text-muted)']]);
    // a single readable box: no stripe, no picker
    const one = await boot({ handler: standard({ 'GET /api/mail/mailboxes': () => ({ mailboxes: [MB[0]], viewer: { su: false, role: null } }) }) });
    const r1 = one.doc.querySelector('#msg-list .msg');
    expect([r1.classList.contains('boxed'), r1.style.getPropertyValue('--mbc-l')]).toEqual([false, '']);
    expect(one.doc.getElementById('mb-btn').hidden).toBe(true);
  });

  test('views keep a combined set: Save stores it, Update replaces it, the list shows each view\'s boxes', async () => {
    const MB3 = [...MB, { id: 3, address: 'shoshana@mdbl.test', display_name: null, active: true, can_send: true, can_manage: false, inbox_total: 4, inbox_unread: 4 }];
    let views = [{ id: 4, name: 'Old', mailbox_ids: [2], filters: {}, is_default: false, sort_order: 0 }];
    const { window, doc, calls } = await boot({
      handler: standard({
        'GET /api/mail/mailboxes': () => ({ mailboxes: MB3, viewer: { su: false, role: null } }),
        'GET /api/mail/views': () => ({ views }),
        'POST /api/mail/views': (p) => { const v = { id: 5, sort_order: 0, ...p, mailbox_ids: p.mailbox_ids || null }; views = views.concat(v); return { view: v }; },
        'PATCH /api/mail/views/4': (p) => { views = views.map((v) => (v.id === 4 ? { ...v, ...p } : v)); return { view: views[0] }; },
      }),
    });
    doc.getElementById('mb-btn').click();
    const box = (id) => doc.querySelector(`#mb-panel input[data-id="${id}"]`);
    box(2).checked = false;
    box(2).dispatchEvent(new window.Event('change'));
    doc.getElementById('f-unread').click();
    await tick(window);
    doc.getElementById('views-btn').click();
    expect(doc.querySelector('#vw-list .vw-sum').textContent).toBe('intake@firm.test');
    doc.getElementById('vw-name').value = 'SB desk';
    doc.getElementById('vw-save').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views' && c.method === 'POST').payload)
      .toEqual({ name: 'SB desk', filters: { unread_only: true }, is_default: false, mailbox_ids: [1, 3] });
    const sums = [...doc.querySelectorAll('#vw-list .vw-sum')].map((x) => x.textContent);
    expect(sums).toEqual(['intake@firm.test', 'Billingshoshana@mdbl.test— unread']);
    [...doc.querySelectorAll('#vw-list button')].find((b) => b.textContent === 'Update').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/views/4' && c.method === 'PATCH').payload)
      .toEqual({ mailbox_ids: [1, 3], filters: { unread_only: true } });
  });

  test('a view whose mailboxes were all revoked shows nothing — never falls back to everything', async () => {
    const views = [{ id: 7, name: 'Gone', mailbox_ids: [9], filters: {}, is_default: true, sort_order: 0 }];
    const { doc, calls } = await boot({ handler: standard({ 'GET /api/mail/views': () => ({ views }), 'GET /api/mail/messages': () => ({ messages: [], next_cursor: null }) }) });
    expect(calls.find((c) => c.url === '/api/mail/messages').payload.mailbox_ids).toBe('9');
    expect(doc.getElementById('mb-label').textContent).toBe('No shared mailboxes');
    // and it cannot be saved as a new view in that state
    doc.getElementById('views-btn').click();
    doc.getElementById('vw-name').value = 'x';
    doc.getElementById('vw-save').click();
    expect(doc.getElementById('views-msg').textContent).toMatch(/at least one mailbox/);
    expect(calls.some((c) => c.url === '/api/mail/views' && c.method === 'POST')).toBe(false);
  });

  test('Mark all read: the picker set + on-screen filters, only after a confirm', async () => {
    const { window, doc, calls } = await boot({ handler: standard({ 'POST /api/mail/read': () => ({ marked: 3 }) }) });
    doc.getElementById('mb-btn').click();
    const b2 = doc.querySelector('#mb-panel input[data-id="2"]');
    b2.checked = false; b2.dispatchEvent(new window.Event('change'));
    const dom = doc.getElementById('f-domain');
    dom.value = 'court.test'; dom.dispatchEvent(new window.Event('change'));
    await tick(window);
    const asked = [];
    window.confirm = (m) => { asked.push(m); return false; };
    doc.getElementById('readall-btn').click();
    await tick(window);
    expect(calls.some((c) => c.url === '/api/mail/read')).toBe(false);
    expect(asked[0]).toMatch(/only those matching the filters/);
    window.confirm = () => true;
    doc.getElementById('readall-btn').click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/read').payload).toEqual({ all: true, filters: { from_domain: 'court.test' }, mailbox_ids: [1] });
  });

  test('load more passes next_cursor back unchanged', async () => {
    let n = 0;
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/mail/messages': () => (n++ === 0 ? { messages: [ROWS[0]], next_cursor: '1759932000000.11' } : { messages: [ROWS[1]], next_cursor: null }) }),
    });
    doc.getElementById('more-btn').click();
    await tick(window);
    expect(calls.filter((c) => c.url === '/api/mail/messages')[1].payload.cursor).toBe('1759932000000.11');
    expect(doc.querySelectorAll('#msg-list .msg')).toHaveLength(2);
    expect(doc.getElementById('more-btn')).toBeNull();
  });

  test('no mailboxes shared → the empty hub says why (not an error)', async () => {
    const { doc, errors } = await boot({
      handler: standard({ 'GET /api/mail/mailboxes': () => ({ mailboxes: [], viewer: { su: false, role: null } }), 'GET /api/mail/messages': () => ({ messages: [], next_cursor: null }) }),
    });
    expect(errors).toEqual([]);
    expect(doc.querySelector('#msg-list .empty').textContent).toMatch(/No mailboxes are shared with you/);
    expect(doc.getElementById('list-error').textContent).toBe('');
  });

  test('stacked navigation: opening switches to the thread, Back returns to the list', async () => {
    const { window, doc } = await boot({ handler: standard(), width: 375 });
    const email = doc.getElementById('email');
    expect(email.classList.contains('show-thread')).toBe(false);
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    expect(email.classList.contains('show-thread')).toBe(true);
    doc.getElementById('back-btn').click();
    expect(email.classList.contains('show-thread')).toBe(false);
    // the CSS that makes it stacked lives in the phone media block
    const css = HTML.match(/@media \(max-width: 768px\) \{([\s\S]*?)\n  \}/)[1];
    expect(css).toMatch(/\.email:not\(\.show-thread\) \.thread-col \{ display: none; \}/);
    expect(css).toMatch(/\.email\.show-thread \.list-col \{ display: none; \}/);
  });
});
