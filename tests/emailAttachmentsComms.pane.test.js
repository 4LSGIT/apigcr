/**
 * @jest-environment node
 *
 * tests/emailAttachmentsComms.pane.test.js — email attachments S3 in the Comms
 * pane (public/comms.html; ref/EMAIL_ATTACHMENTS_DESIGN.md §9), on
 * tests/mailboxS2P.pane.test.js's harness (the real page in jsdom, apiSend
 * stubbed per route):
 *
 *   - the "Not filed" chip rides every list call and counts in "Filters (n)";
 *   - an attachment's "Filed" chip, its Save button (= the dialog with ONLY
 *     that file ticked) and the card's "File to case…" (every file);
 *   - the dialog: the preview's ticks, the locked rows (skip / filed), the
 *     tags, the case — suggested, picked from a candidate (read again
 *     against it), or none ("Pick a case first");
 *   - File: the confirm step for a confirm part (then `confirm` carries it),
 *     ONE request per email with the batch, a failed email stopping nothing,
 *     the reviewer's notice for the batch (none when the reviewer is the one
 *     filing, or the box is unticked), the summary, Close re-reading the
 *     list and the open conversation;
 *   - the list's select mode: a click ticks instead of opening, Same sender,
 *     All shown, the 50 cap, File attachments with the ticked ids;
 *   - a conversation with several emails with files: one link files them all;
 *   - S3b: the folder choice (the case folder's subfolders read once, a typed
 *     or picked folder sent EXACTLY — leading space kept; none = the default)
 *     and the names-in-the-subject suggestions (said, never picked).
 *
 * Mutation-checked (2026-11-10): the confirm step skipped; `confirm` not sent;
 * the batch sent when the reviewer is the filer; the notice sent with the box
 * unticked; onlyPart ignored (every default tick kept); select mode opening
 * the email; Same sender ticking every row; not_filed missing from the list
 * call; a failed email stopping the run.
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
const OPTOUT = fs.readFileSync(path.join(ROOT, 'public/js/optoutAck.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));

const MB = [
  { id: 1, address: 'stuart@firm.test', display_name: 'Stuart', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 0 },
];
const ROW = (over = {}) => ({
  id: 11, mailbox_id: 1, mailbox_address: 'stuart@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null,
  message_id: 'm11@x.test', thread_key: 'm11@x.test', from_addr: 'Michele Boren <michele@client.test>', to_addrs: 'stuart@firm.test',
  cc_addrs: null, subject: 'paystubs', date: '2026-11-08T14:00:00.000Z', snippet: 'snip', unread: false,
  attachment_count: 2, log_id: null, log_status: { state: 'store_only' },
  case: null, copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'stuart@firm.test', folder: 'INBOX', place: null, unread: false }],
  ...over,
});
const ROWS = [
  ROW(),
  ROW({ id: 12, message_id: 'm12@x.test', thread_key: 'm12@x.test', subject: 'w2', date: '2026-11-08T15:00:00.000Z' }),
  ROW({ id: 13, message_id: 'm13@x.test', thread_key: 'm13@x.test', from_addr: 'Her Mom <mom@else.test>', subject: 'for michele' }),
];
const TMSG = (over = {}) => ({
  ...ROW(), body_text: 'here', body_html: null, from_email: 'michele@client.test', images_trusted: false,
  attachments: [
    { part: '2', filename: 'stub.pdf', mime: 'application/pdf', size: 4000, inline: false },
    { part: '3', filename: 'scans.zip', mime: 'application/zip', size: 9000, inline: false, filed: { status: 'filed', placement: 'case', link_type: 'case', link_id: 'PVXC1RMM', path: '/cases/b/Client Uploads/Emailed 261108/scans.zip', filed_at: '2026-11-08T16:00:00.000Z' } },
  ],
  ...over,
});
const CASE = { case_id: 'PVXC1RMM', case_number: '26-40001', case_type: 'Bankruptcy', case_stage: 'Open' };
const PART = (over) => ({ part: '2', filename: 'stub.pdf', mime: 'application/pdf', bytes: 2960, kind: 'file', reason: null, confirm: null, filed: null, duplicate: null, checked: true, ...over });
const PMSG = (id, over = {}) => ({
  id, mailbox_id: 1, from: 'Michele Boren <michele@client.test>', subject: `email ${id}`, date: '2026-11-08T14:00:00.000Z',
  match: { case_id: 'PVXC1RMM', method: 'sender_open_case', flag: null, reason: null }, move: null, parts: [PART()], ...over,
});
const PREVIEW = (over = {}) => ({
  case: CASE, suggested: true, candidates: [CASE],
  messages: [
    PMSG(11, { parts: [
      PART(),
      PART({ part: '3', filename: 'scans.zip', mime: 'application/zip', bytes: 6660, kind: 'optional', confirm: 'type', checked: false }),
      PART({ part: '4', filename: 'run.exe', kind: 'skip', reason: 'blocked', checked: false }),
      PART({ part: '5', filename: 'old.pdf', filed: { status: 'filed', placement: 'unsorted', case_id: null, link_type: null, path: '/bin/old.pdf' }, checked: false }),
    ], move: { count: 1, unsorted: 1, case_ids: [], checked: true } }),
    PMSG(12, { parts: [PART({ filename: 'w2.pdf', duplicate: { mail_message_id: 7, filed_at: '2026-11-01T10:00:00.000Z', path: '/cases/b/w2.pdf', in_selection: false }, checked: false }), PART({ part: '3', filename: 'w2b.pdf' })] }),
  ],
  reviewer: { user_id: 5, name: 'Shana', is_you: false },
  policy: { confirm_mb: 15, confirm_types: null }, max_messages: 50,
  ...over,
});

async function boot({ handler } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user: 6, user_name: 'Fred' }, users: [] };
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
  return { window, doc: window.document, calls, errors };
}

function standard(over = {}) {
  return (url, method, payload) => {
    if (over[`${method} ${url}`]) return over[`${method} ${url}`](payload);
    if (url === '/api/mail/mailboxes') return { mailboxes: fresh(MB), viewer: { su: false, role: null, can_send: true }, inbox_unread_distinct: 0 };
    if (url === '/api/mail/views') return { views: [] };
    if (url === '/api/mail/views/counts') return { counts: {} };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: fresh(ROWS), next_cursor: null };
    if (/^\/api\/mail\/threads\//.test(url)) return { thread_key: 'm11@x.test', subject: 'paystubs', truncated: false, messages: [TMSG()] };
    if (url === '/api/mail/read' && method === 'POST') return { marked: 0 };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [], unmatched: [] };
    if (url === '/api/mail/attachments/preview') return PREVIEW();
    if (/^\/api\/mail\/messages\/\d+\/attachments\/file$/.test(url)) {
      return { id: Number(url.split('/')[4]), case: CASE, files: (payload.parts || []).map((p) => ({ part: p, filename: `f${p}`, status: 'filed' })), skipped: [], refiled: payload.move ? { moved: 1, already_there: 0, failed: [], warnings: [] } : null, linked: !!payload.link, link_error: null };
    }
    if (url === '/api/mail/attachments/notice') return { sent: true, to: { user_id: 5, name: 'Shana' }, count: 2, notices: 1 };
    if (url === '/api/mail/attachments/folders') return { case_id: payload.case_id, folders: [' 012 - Supplemental Responses', 'Client Uploads', 'Client Uploads/Emailed 261108'], truncated: false, reason: null };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

const openThread = async (window, doc) => { doc.querySelector('#msg-list .msg').click(); await tick(window, 80); };
const faOpen = (doc) => doc.getElementById('fd-backdrop').classList.contains('open');
const rowsOf = (doc, id) => [...doc.querySelectorAll(`#fd-body .fd-msg[data-id="${id}"] .fd-part`)];
const partRow = (doc, id, part) => doc.querySelector(`#fd-body .fd-msg[data-id="${id}"] .fd-part[data-part="${part}"]`);
const box = (row) => row.querySelector('input[type="checkbox"]');
const tick1 = (doc, id, part, on, window) => { const cb = box(partRow(doc, id, part)); cb.checked = on; cb.dispatchEvent(new window.Event('change')); };
const fileCalls = (calls) => calls.filter((c) => /\/attachments\/file$/.test(c.url));

// ─────────────────────────────────────────────────────────────────────────────
describe('the list', () => {
  test('"Not filed" rides every list call and counts in Filters (n)', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    const lists = () => calls.filter((c) => c.url === '/api/mail/messages');
    expect(lists()[0].payload.not_filed).toBe(0);
    doc.getElementById('f-notfiled').click();
    await tick(window, 60);
    expect(doc.getElementById('f-notfiled').getAttribute('aria-pressed')).toBe('true');
    expect(lists().pop().payload).toMatchObject({ not_filed: 1, has_files: 0 });
    expect(doc.getElementById('fbar-n').textContent).toBe('Filters (1)');
    expect(errors).toEqual([]);
  });

  test('select mode: a click ticks (never opens); Same sender; All shown; File attachments sends the ticked ids; Done', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    expect(doc.getElementById('sel-bar').hidden).toBe(true);
    doc.getElementById('sel-btn').click();
    expect(doc.getElementById('sel-bar').hidden).toBe(false);
    expect(doc.querySelectorAll('#msg-list .msg .selbox')).toHaveLength(3);
    expect(doc.getElementById('sel-file').disabled).toBe(true);
    doc.querySelector('#msg-list .msg[data-id="12"]').click();
    await tick(window, 40);
    expect(calls.some((c) => /\/threads\//.test(c.url))).toBe(false);          // ticked, not opened
    expect(doc.querySelector('#msg-list .msg[data-id="12"]').getAttribute('aria-checked')).toBe('true');
    expect(doc.getElementById('sel-n').textContent).toBe('1 selected');
    doc.getElementById('sel-sender').click();                                    // michele's other email, not her mom's
    expect([...doc.querySelectorAll('#msg-list .msg.picked')].map((li) => li.dataset.id)).toEqual(['11', '12']);
    doc.getElementById('sel-file').click();
    await tick(window, 60);
    expect(faOpen(doc)).toBe(true);
    expect(calls.find((c) => c.url === '/api/mail/attachments/preview').payload).toEqual({ message_ids: [12, 11] });
    doc.getElementById('fd-cancel').click();
    doc.getElementById('sel-all').click();
    expect(doc.getElementById('sel-n').textContent).toBe('3 selected');
    doc.getElementById('sel-done').click();
    expect(doc.getElementById('sel-bar').hidden).toBe(true);
    expect(doc.querySelectorAll('#msg-list .selbox')).toHaveLength(0);
    doc.querySelector('#msg-list .msg[data-id="11"]').click();                   // opens again
    await tick(window, 60);
    expect(calls.some((c) => /\/threads\//.test(c.url))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('more than 50 ticked: File attachments is refused with the reason', async () => {
    const many = Array.from({ length: 51 }, (_, i) => ROW({ id: 100 + i, message_id: `m${i}@x`, thread_key: `m${i}@x` }));
    const { doc } = await boot({ handler: standard({ 'GET /api/mail/messages': () => ({ messages: fresh(many), next_cursor: null }) }) });
    doc.getElementById('sel-btn').click();
    doc.getElementById('sel-all').click();
    expect(doc.getElementById('sel-n').textContent).toBe('51 selected — at most 50 at a time');
    expect(doc.getElementById('sel-file').disabled).toBe(true);
  });
});

describe('the card', () => {
  test('a filed attachment says Filed (where, in its title); Save opens the dialog with ONLY that file ticked; File to case… keeps every default', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    await openThread(window, doc);
    const att3 = doc.querySelector('.att[data-part="3"]');
    expect(att3.querySelector('.att-filed').textContent).toBe('Filed');
    expect(att3.querySelector('.att-filed').title).toBe('Filed to case PVXC1RMM — /cases/b/Client Uploads/Emailed 261108/scans.zip');
    expect(doc.querySelector('.att[data-part="2"] .att-filed')).toBeNull();
    // Save on part 2 (the preview would tick 11/2 and 12/3 and the move by default)
    doc.querySelector('.att[data-part="2"] .att-save').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/preview').pop().payload).toEqual({ message_ids: [11] });
    const ticked = [...doc.querySelectorAll('#fd-body .fd-part input:checked')].map((cb) => [cb.closest('.fd-msg').dataset.id, cb.closest('.fd-part').dataset.part || 'move']);
    expect(ticked).toEqual([['11', '2']]);
    expect(doc.getElementById('fd-go').textContent).toBe('File 1 file');
    doc.getElementById('fd-cancel').click();
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    const all = [...doc.querySelectorAll('#fd-body .fd-part input:checked')].map((cb) => [cb.closest('.fd-msg').dataset.id, cb.closest('.fd-part').dataset.part || 'move']);
    expect(all).toEqual([['11', '2'], ['11', 'move'], ['12', '3']]);
    expect(doc.getElementById('fd-go').textContent).toBe('File 2 files, move 1');
    expect(errors).toEqual([]);
  });

  test('a conversation with several emails with files: one link opens the dialog for all of them', async () => {
    const thread = { thread_key: 't', subject: 's', truncated: false, messages: [TMSG({ id: 11 }), TMSG({ id: 12, attachments: [] }), TMSG({ id: 14, copies: [{ id: 14, mailbox_id: 1 }] })] };
    const { window, doc, calls } = await boot({ handler: standard({ 'GET /api/mail/threads/m11%40x.test': () => fresh(thread) }) });
    await openThread(window, doc);
    const link = doc.querySelector('.thread-note .thread-file');
    expect(link.textContent).toBe('File the attachments of its 2 emails…');
    link.click();
    await tick(window, 60);
    expect(calls.find((c) => c.url === '/api/mail/attachments/preview').payload).toEqual({ message_ids: [11, 14] });
  });
});

describe('the dialog', () => {
  test('what the preview says: ticks, locked rows, tags, the move, the case', async () => {
    const { window, doc, errors } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    expect(doc.querySelector('#fd-body .fd-case').textContent).toMatch(/To case.*26-40001.*Open.*every email matches this case.*Change/s);
    const r = (id, p) => partRow(doc, id, p);
    expect([box(r(11, '2')).checked, box(r(11, '2')).disabled]).toEqual([true, false]);
    expect([box(r(11, '3')).checked, box(r(11, '3')).disabled]).toEqual([false, false]);
    expect(r(11, '3').textContent).toMatch(/scans\.zip.*Not a usual document type.*Asks to confirm/s);
    expect([box(r(11, '4')).checked, box(r(11, '4')).disabled]).toEqual([false, true]);
    expect(r(11, '4').textContent).toContain('Never filed — the firm blocks this file type');
    expect(box(r(11, '5')).disabled).toBe(true);
    expect(r(11, '5').textContent).toContain('Filed to Unsorted');
    expect(r(12, '2').textContent).toContain('Already in this case (filed Nov 1)');
    expect(box(r(12, '2')).checked).toBe(false);
    const move = doc.querySelector('#fd-body .fd-msg[data-id="11"] .fd-move');
    expect(move.textContent).toBe('Move the 1 file already filed to Unsorted into this case');
    expect(box(move).checked).toBe(true);
    expect(doc.getElementById('fd-link').checked).toBe(true);
    expect(doc.getElementById('fd-notify').checked).toBe(true);
    expect(doc.querySelector('#fd-body .fd-opts').textContent).toContain('Send Shana the review notice');
    // Font Awesome owns every fa-* class (.fa sets its icon font; fa-tag, fa-list, fa-search… draw icons):
    // only the <i> icons inside the dialog may carry one
    expect([...doc.querySelectorAll('#fd-backdrop [class]')].filter((el) => el.tagName !== 'I' && /(^|\s)fa(-|\s|$)/.test(el.className)).map((el) => el.className)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('no case to suggest: File is "Pick a case first"; a candidate reads everything again against it', async () => {
    const two = { case_id: 'CF8ZT7VE', case_number: '26-40002', case_type: 'Bankruptcy', case_stage: 'Filed' };
    const { window, doc, calls } = await boot({
      handler: standard({
        'POST /api/mail/attachments/preview': (p) => (p.case_id ? PREVIEW({ case: two, suggested: false, candidates: [two, CASE] }) : PREVIEW({ case: null, suggested: false, candidates: [CASE, two] })),
      }),
    });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    expect(doc.getElementById('fd-go').textContent).toBe('Pick a case first');
    expect(doc.getElementById('fd-go').disabled).toBe(true);
    const cands = [...doc.querySelectorAll('#fd-body .fd-case .cand')];
    expect(cands.map((b) => b.textContent)).toEqual(['26-40001', '26-40002']);
    cands[1].click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/preview').pop().payload).toEqual({ message_ids: [11], case_id: 'CF8ZT7VE' });
    expect(doc.querySelector('#fd-body .fd-case').textContent).toMatch(/To case.*26-40002/s);
    expect(doc.querySelector('#fd-body .fd-case').textContent).not.toMatch(/null/);    // no stray null child (not suggested)
    // the matcher's own case differs from the chosen one: said, not blocked
    expect(doc.querySelector('#fd-body .fd-msg[data-id="11"] .fd-note.warn').textContent).toContain("The sender's case looks like 26-40001");
    expect(doc.getElementById('fd-go').disabled).toBe(false);
  });

  test('File: the confirm step first; then one request per email with the batch; the notice; the summary; Close re-reads', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    tick1(doc, 11, '3', true, window);                                           // the zip: a confirm part
    expect(doc.getElementById('fd-go').textContent).toBe('File 3 files, move 1');
    doc.getElementById('fd-go').click();
    await tick(window, 40);
    expect(fileCalls(calls)).toHaveLength(0);                                    // asked first
    expect(doc.querySelector('#fd-body .fd-confirm').textContent).toBe('Please confirm this file: scans.zip (not a usual document type). File anyway?');
    expect(doc.getElementById('fd-go').textContent).toBe('Yes, file them');
    doc.getElementById('fd-go').click();
    await tick(window, 120);
    const fc = fileCalls(calls);
    expect(fc.map((c) => c.url)).toEqual(['/api/mail/messages/11/attachments/file', '/api/mail/messages/12/attachments/file']);
    const batch = fc[0].payload.batch;
    expect(batch).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(fc[0].payload).toEqual({ case_id: 'PVXC1RMM', parts: ['2', '3'], confirm: ['3'], move: true, link: true, batch });
    expect(fc[1].payload).toEqual({ case_id: 'PVXC1RMM', parts: ['3'], confirm: [], move: false, link: true, batch });
    expect(calls.find((c) => c.url === '/api/mail/attachments/notice').payload).toEqual({ batch });
    expect(doc.querySelector('#fd-body .fd-msg[data-id="11"] .fd-res').textContent).toBe('Filed 2 files · moved 1 · linked to the case');
    expect(doc.querySelector('#fd-body .fd-summary').textContent).toBe('Filed 3 files and moved 1 file — case 26-40001, 2 of 2 emails done. Shana was sent the review notice.');
    expect(doc.getElementById('fd-go').hidden).toBe(true);
    expect(doc.getElementById('fd-cancel').textContent).toBe('Close');
    expect(box(partRow(doc, 11, '2')).disabled).toBe(true);                       // nothing changes after the run
    const before = calls.length;
    doc.getElementById('fd-cancel').click();
    await tick(window, 80);
    expect(faOpen(doc)).toBe(false);
    const after = calls.slice(before).map((c) => c.url);
    expect(after).toContain('/api/mail/messages');                               // the list again (Not filed, chips)
    expect(after.some((u) => /\/threads\//.test(u))).toBe(true);                // the open conversation again
    expect(errors).toEqual([]);
  });

  test('a failed email stops nothing; the summary says so; unticking a confirm part drops the confirm step', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({
        'POST /api/mail/messages/11/attachments/file': () => { throw Object.assign(new Error('Message not found'), { status: 404 }); },
      }),
    });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    tick1(doc, 11, '3', true, window);
    doc.getElementById('fd-go').click();
    await tick(window, 40);
    expect(doc.querySelector('#fd-body .fd-confirm')).not.toBeNull();
    tick1(doc, 11, '3', false, window);                                          // changed her mind
    expect(doc.querySelector('#fd-body .fd-confirm')).toBeNull();
    doc.getElementById('fd-go').click();                                         // no confirm needed now
    await tick(window, 120);
    expect(fileCalls(calls).map((c) => c.url)).toEqual(['/api/mail/messages/11/attachments/file', '/api/mail/messages/12/attachments/file']);
    expect(doc.querySelector('#fd-body .fd-msg[data-id="11"] .fd-res.err').textContent).toBe('Message not found');
    expect(doc.querySelector('#fd-body .fd-summary').textContent)
      .toBe('Filed 1 file — case 26-40001, 1 of 2 emails done. 1 email failed: open File attachments again to retry (what landed shows as filed). Shana was sent the review notice.');
  });

  test('the reviewer filing herself: no batch, no notice, and the dialog says why; the notify box unticked: no notice either', async () => {
    let b = await boot({ handler: standard({ 'POST /api/mail/attachments/preview': () => PREVIEW({ reviewer: { user_id: 6, name: 'Fred', is_you: true } }) }) });
    await openThread(b.window, b.doc);
    b.doc.querySelector('.atts .att-file').click();
    await tick(b.window, 60);
    expect(b.doc.getElementById('fd-notify')).toBeNull();
    expect(b.doc.querySelector('#fd-body .fd-opts').textContent).toContain('You review emailed documents, so no review notice is sent.');
    b.doc.getElementById('fd-go').click();
    await tick(b.window, 120);
    expect(fileCalls(b.calls).every((c) => !('batch' in c.payload))).toBe(true);
    expect(b.calls.some((c) => c.url === '/api/mail/attachments/notice')).toBe(false);

    b = await boot({ handler: standard() });
    await openThread(b.window, b.doc);
    b.doc.querySelector('.atts .att-file').click();
    await tick(b.window, 60);
    const nt = b.doc.getElementById('fd-notify');
    nt.checked = false; nt.dispatchEvent(new b.window.Event('change'));
    const lk = b.doc.getElementById('fd-link');
    lk.checked = false; lk.dispatchEvent(new b.window.Event('change'));
    b.doc.getElementById('fd-go').click();
    await tick(b.window, 120);
    expect(fileCalls(b.calls).map((c) => [c.payload.link, 'batch' in c.payload])).toEqual([[false, false], [false, false]]);
    expect(b.calls.some((c) => c.url === '/api/mail/attachments/notice')).toBe(false);
  });

  test('S3b folder: Another folder reads the case folder once, offers its folders; File sends the folder EXACTLY; the default sends none', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    const radios = [...doc.querySelectorAll('#fd-body .fd-folder input[type="radio"]')];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([['default', true], ['other', false]]);
    expect(doc.getElementById('fd-folder-path')).toBeNull();
    radios[1].checked = true; radios[1].dispatchEvent(new window.Event('change'));
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/folders').map((c) => c.payload)).toEqual([{ case_id: 'PVXC1RMM' }]);
    expect([...doc.querySelectorAll('#fd-folder-list option')].map((o) => o.value)).toEqual([' 012 - Supplemental Responses', 'Client Uploads', 'Client Uploads/Emailed 261108']);
    expect(doc.getElementById('fd-folder-note').textContent).toMatch(/^3 folders in the case folder — pick one, or type a new one/);
    expect(doc.getElementById('fd-go').textContent).toBe('Pick a folder');
    expect(doc.getElementById('fd-go').disabled).toBe(true);
    const inp = doc.getElementById('fd-folder-path');
    inp.value = ' 012 - Supplemental Responses'; inp.dispatchEvent(new window.Event('input'));
    expect(doc.getElementById('fd-go').textContent).toBe('File 2 files, move 1');
    // a re-render (ticking a box, or back to the default and out again) keeps the folder; the list is read once per case
    tick1(doc, 12, '3', false, window);
    tick1(doc, 12, '3', true, window);
    const flip = (v) => { const r = doc.querySelector(`#fd-body .fd-folder input[value="${v}"]`); r.checked = true; r.dispatchEvent(new window.Event('change')); };
    flip('default'); flip('other');
    await tick(window, 40);
    expect(doc.getElementById('fd-folder-path').value).toBe(' 012 - Supplemental Responses');
    doc.getElementById('fd-go').click();
    await tick(window, 120);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/folders')).toHaveLength(1);
    expect(fileCalls(calls).map((c) => c.payload.folder)).toEqual([' 012 - Supplemental Responses', ' 012 - Supplemental Responses']);
    expect(errors).toEqual([]);

    const b = await boot({ handler: standard() });
    await openThread(b.window, b.doc);
    b.doc.querySelector('.atts .att-file').click();
    await tick(b.window, 60);
    b.doc.getElementById('fd-go').click();
    await tick(b.window, 120);
    expect(fileCalls(b.calls).every((c) => !('folder' in c.payload))).toBe(true);
    expect(b.calls.some((c) => c.url === '/api/mail/attachments/folders')).toBe(false);
  });

  test('S3b names: cases suggested from names in the subject say so, and are only offered', async () => {
    const named = { case_id: 'CMKA8RKX', case_number: '26-03006-jda', case_type: 'Bankruptcy', case_stage: 'Open', why: 'subject_name', contact_name: 'Michele Boren' };
    const { window, doc, calls } = await boot({
      handler: standard({ 'POST /api/mail/attachments/preview': (p) => (p.case_id ? PREVIEW({ case: named, suggested: false }) : PREVIEW({ case: null, suggested: false, candidates: [named] })) }),
    });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    const chip = doc.querySelector('#fd-body .fd-case .cand');
    expect(chip.title).toBe('Michele Boren is named in the subject · Bankruptcy · Open');
    expect(doc.querySelector('#fd-body .fd-named').textContent).toBe('Suggested because the subject names Michele Boren — check before you pick.');
    expect(doc.getElementById('fd-go').textContent).toBe('Pick a case first');
    chip.click();
    await tick(window, 60);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/preview').pop().payload).toEqual({ message_ids: [11], case_id: 'CMKA8RKX' });
    expect(doc.querySelector('#fd-body .fd-named')).toBeNull();
  });

  test('S3c: a case shows its subtype and client — the chips, the picker\'s suggestions, the case search', async () => {
    const adv = { case_id: 'CMKA8RKX', case_number: '26-03006-jda', case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding', case_stage: 'Open', case_caption: 'Cohen v. Boren', primary_contact_name: 'Michele Boren', why: 'subject_name', contact_name: 'Michele Boren' };
    const ch7 = { case_id: 'FW13PDQT', case_number: '25-32362-jda', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_stage: 'Open', case_caption: null, primary_contact_name: 'Michele Boren', why: 'subject_name', contact_name: 'Michele Boren' };
    const { window, doc } = await boot({
      handler: standard({
        'POST /api/mail/attachments/preview': (p) => (p.case_id ? PREVIEW({ case: adv, suggested: false, candidates: [adv, ch7] }) : PREVIEW({ case: null, suggested: false, candidates: [adv, ch7] })),
        'GET /api/cases/search': () => ({ cases: [{ case_id: 'CMKA8RKX', case_number_full: '26-03006-jda', case_type: 'Bankruptcy', case_subtype: 'Adversary Proceeding', case_stage: 'Open', primary_contact_name: 'Michele Boren' }] }),
      }),
    });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    expect([...doc.querySelectorAll('#fd-body .fd-case .cand')].map((b) => b.textContent)).toEqual(['26-03006-jda · Adversary Proceeding', '25-32362-jda · Chapter 7']);
    doc.querySelector('#fd-body .fd-search').click();
    expect([...doc.querySelectorAll('#case-sugg li .l2')].map((x) => x.textContent)).toEqual([
      'Bankruptcy · Adversary Proceeding · Michele Boren is named in the subject', 'Bankruptcy · Chapter 7 · Michele Boren is named in the subject']);
    const q = doc.getElementById('case-q');
    q.value = 'bor'; q.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    expect(doc.querySelector('#case-results li .l2').textContent).toBe('CMKA8RKX · Bankruptcy · Adversary Proceeding · Open');
    doc.querySelector('#case-sugg li').click();
    await tick(window, 60);
    expect(doc.querySelector('#fd-body .fd-case').textContent).toMatch(/To case.*26-03006-jda.*Adversary Proceeding.*Open/s);
  });

  test('Escape closes it; the case picker opens over it and its pick comes back', async () => {
    const { window, doc, calls } = await boot({
      handler: standard({ 'GET /api/cases/search': () => ({ cases: [{ case_id: 'ZZZZ9999', case_number: '26-49999', case_type: 'BK' }] }) }),
    });
    await openThread(window, doc);
    doc.querySelector('.atts .att-file').click();
    await tick(window, 60);
    doc.querySelector('#fd-body .fd-change').click();
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(true);
    expect(doc.getElementById('case-sugg-label').textContent).toBe('Suggested from these emails');
    const q = doc.getElementById('case-q');
    q.value = '26'; q.dispatchEvent(new window.Event('input'));
    await tick(window, 320);
    doc.querySelector('#case-results li').click();
    await tick(window, 60);
    expect(doc.getElementById('case-backdrop').classList.contains('open')).toBe(false);
    expect(calls.filter((c) => c.url === '/api/mail/attachments/preview').pop().payload).toEqual({ message_ids: [11], case_id: 'ZZZZ9999' });
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(faOpen(doc)).toBe(false);
  });
});
