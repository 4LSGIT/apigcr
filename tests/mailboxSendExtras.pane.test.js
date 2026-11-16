/**
 * @jest-environment node
 *
 * tests/mailboxSendExtras.pane.test.js — the composer's Attach picker, Send
 * later and the Scheduled list in the comms hub pane (public/comms.html),
 * hub-send extras 2026-11-16. Run: npx jest tests/mailboxSendExtras.pane.test.js
 *
 * Boots the real pane in jsdom against a stub shell apiSend (the S3 pane
 * harness) and drives it through the DOM. What is locked:
 *   - Boot makes NO new call (the Scheduled list loads when asked for); the
 *     rail's Scheduled entry shows with Compose; both composers (new, reply)
 *     carry Files + Send later.
 *   - Attach: GET /api/documents with q (limit 20); with a case on the
 *     composer the picker opens on that case's files (link_type / link_id)
 *     and unticks to a plain search; a chip is name · size · ×; the courtesy
 *     caps (size unknown, over the cap, already attached) disable rows and
 *     say why; the send payload carries attachments [{document_id}]; a draft
 *     keeps the picked files.
 *   - Send later: a firm-time pick becomes an instant (firmLocalToIso — EST
 *     and EDT both, proved against Luxon); the client window check refuses a
 *     pick under the minimum before any call; Schedule POSTs the SAME payload
 *     as Send + send_at, closes the composer, toasts, and re-reads the list.
 *   - Scheduled: the rows in firm time with a status pill; Cancel is an
 *     in-page two-step (Keep / Yes); Yes → DELETE; a 409's text is shown as
 *     the server gives it.
 *
 * Mutation-checked (worker run 2026-11-16): the attachments key dropped from
 * the payload → "the payload carries attachments"; firmLocalToIso returning
 * the wall clock as UTC → the EST/EDT test; the client minimum check dropped
 * → "under the minimum"; attachRefusal's size-unknown rule dropped → the
 * picker test; the two-step confirm collapsed to one click → the Cancel test;
 * the Scheduled list fetched at boot → "boot makes no new call".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { DateTime } = require('luxon');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/comms.html'), 'utf8');
const PURIFY = fs.readFileSync(path.join(ROOT, 'public/js/vendor/purify-3.4.16.min.js'), 'utf8');
const RENDER = fs.readFileSync(path.join(ROOT, 'public/js/mailRender.js'), 'utf8');
const COLOR = fs.readFileSync(path.join(ROOT, 'public/js/mailboxColor.js'), 'utf8');
const OPTOUT = fs.readFileSync(path.join(ROOT, 'public/js/optoutAck.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const MiB = 1024 * 1024;

const MB = [
  { id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, can_send: true, can_manage: false, inbox_total: 3, inbox_unread: 2 },
];
const IDENTITIES = {
  max_recipients: 10,
  limits: { max_attachments: 3, attachment_max_bytes: 15 * MiB, attachments_total_bytes: 15 * MiB, schedule_min_ahead_ms: 120_000, schedule_max_ahead_ms: 30 * 86_400_000 },
  identities: [{ id: 1, address: 'billing@firm.test', display_name: 'Billing', color: '#2f6fd1', active: true, sendable: true, reason: null, reason_text: null, signature: false }],
};
const ROWS = [
  { id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null, thread_key: 'root@x.test', from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test', cc_addrs: null, subject: 'Plan', date: '2026-10-08T14:00:00.000Z', snippet: 's', unread: false, attachment_count: 0, log_id: null, case: null },
];
const THREAD = {
  thread_key: 'root@x.test', subject: 'Plan', truncated: false,
  messages: [{
    id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', in_inbox: true, sent: false, place: null, message_id: 'root@x.test', thread_key: 'root@x.test',
    from_addr: 'Client <client@outside.test>', to_addrs: 'billing@firm.test', cc_addrs: null, subject: 'Plan', date: '2026-10-08T14:00:00.000Z', snippet: 's',
    body_text: 'hello', body_html: null, attachments: [], unread: false, log_id: null, case: null,
    copies: [{ id: 11, mailbox_id: 1, mailbox_address: 'billing@firm.test', folder: 'INBOX', place: null, unread: false }],
  }],
};
const REPLY = { in_reply_to_message_fk: 11, mailbox_id: 1, all: false, max_recipients: 10, over_cap: false, subject: 'Re: Plan', to: [{ email: 'client@outside.test', name: 'Client' }], cc: [], quote: { header: 'On …, Client wrote:', text: 'hello' } };
const DOCS = [
  { id: 1, name: 'One.pdf', title: null, size: 1 * MiB, status: 'active', doc_type: 'Petition', ext: 'pdf' },
  { id: 2, name: 'Unknown.bin', title: null, size: null, status: 'active', doc_type: null, ext: 'bin' },
  { id: 3, name: 'Huge.zip', title: 'The big archive', size: 20 * MiB, status: 'active', doc_type: null, ext: 'zip' },
  { id: 4, name: 'Two.pdf', title: null, size: 2 * MiB, status: 'active', doc_type: null, ext: 'pdf' },
];
const SCHEDULED = [
  { id: 5, send_at: '2026-12-10T14:30:00.000Z', status: 'pending', outcome: null, mailbox: { id: 1, address: 'billing@firm.test' }, to: [{ email: 'c@x.test', name: 'Client' }], cc: [], bcc: [], subject: 'Hello', in_reply_to_message_fk: null, case_id: null, attachments: [{ document_id: 1, name: 'One.pdf', status: 'active' }], acknowledged_optout: false, created_at: '2026-11-16T10:00:00.000Z' },
  { id: 6, send_at: '2026-11-15T14:00:00.000Z', status: 'failed', outcome: { state: 'failed', status: 409, message: 'This mailbox is switched off (Admin → Mailboxes).' }, mailbox: { id: 1, address: 'billing@firm.test' }, to: [{ email: 'd@x.test', name: null }], cc: [], bcc: [], subject: 'Old', in_reply_to_message_fk: null, case_id: null, attachments: [], acknowledged_optout: false, created_at: '2026-11-14T10:00:00.000Z' },
];
const fresh = (v) => JSON.parse(JSON.stringify(v));

async function boot({ handler, mailboxes = MB } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
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
  for (const src of [PURIFY, RENDER, COLOR, OPTOUT, inline[0]]) {
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
    if (url === '/api/phone-lines/readable') return { lines: [], unread_total: 0 };
    if (url === '/api/comms-archive/admin') return { admin: false };
    if (url === '/api/mail/messages' && method === 'GET') return { messages: fresh(ROWS), next_cursor: null };
    if (url === '/api/mail/threads/root%40x.test') return fresh(THREAD);
    if (url === '/api/mail/read' && method === 'POST') return { marked: 0 };
    if (/^\/api\/mail\/messages\/\d+\/related$/.test(url)) return { contacts: [] };
    if (url === '/api/mail/identities') return fresh(IDENTITIES);
    if (url === '/api/mail/messages/11/reply') return fresh(REPLY);
    if (url === '/api/contacts') return { contacts: [] };
    if (url === '/api/documents' && method === 'GET') {
      // a one-letter q lists everything (the picker's first keystroke); three letters filter by name
      const q = payload && payload.q ? String(payload.q).toLowerCase() : '';
      return { documents: fresh(DOCS).filter((d) => q.length < 3 || d.name.toLowerCase().includes(q)), total: 0 };
    }
    if (url === '/api/mail/send/scheduled' && method === 'GET') return { scheduled: fresh(SCHEDULED) };
    if (url === '/api/mail/send' && method === 'POST') return { status: 'success', from: 'billing@firm.test', email_log_id: 5, warnings: [], append: {}, read_seed: {}, attachments: [] };
    if (url === '/api/mail/send/schedule' && method === 'POST') return { status: 'success', job_id: 9, send_at: payload.send_at, from: 'billing@firm.test', recipients: 1, attachments: [] };
    if (/^\/api\/mail\/send\/scheduled\/\d+$/.test(url) && method === 'DELETE') return { status: 'success', id: Number(url.split('/').pop()), status: 'cancelled' };
    throw new Error(`unexpected ${method} ${url}`);
  };
}

const input = (doc, field) => doc.querySelector(`.composer .rcpt[data-field="${field}"] input`);
function type(window, el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}
async function openCompose(window, doc) {
  doc.getElementById('compose-btn').click();
  await tick(window, 40);
}
function fill(window, doc, { to = 'client@outside.test,', subject = 'Hello', body = 'Hi there' } = {}) {
  type(window, input(doc, 'to'), to);
  const s = doc.querySelector('.composer .cf-subject'); s.value = subject; s.dispatchEvent(new window.Event('input'));
  const b = doc.querySelector('.composer .cf-body'); b.value = body; b.dispatchEvent(new window.Event('input'));
}
const chips = (doc) => [...doc.querySelectorAll('.composer .achip')].map((c) => [c.querySelector('.nm').textContent, c.querySelector('.sz').textContent]);
async function openPicker(window, doc) {
  doc.querySelector('.composer .attach-btn').click();
  await tick(window, 40);
}
const docRows = (doc) => [...doc.querySelectorAll('#doc-results li')];

describe('hub-send extras in the pane', () => {
  test('boot makes no new call; the rail\'s Scheduled entry shows with Compose; both composers carry Files + Send later', async () => {
    const { window, doc, calls, errors } = await boot({ handler: standard() });
    expect(errors).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual(['/api/phone-lines/readable', '/api/comms-archive/admin', '/api/mail/mailboxes', '/api/mail/views', '/api/mail/messages']);
    expect(doc.getElementById('rail-sched').hidden).toBe(false);
    expect(doc.getElementById('rail-sched').textContent).toBe('Scheduled'); // no count until the list is asked for
    await openCompose(window, doc);
    expect(calls.map((c) => c.url).filter((u) => /scheduled|documents/.test(u))).toEqual([]);
    expect(doc.querySelector('.composer .files-row .attach-btn').textContent).toBe('Attach a document…');
    expect(doc.querySelector('.composer .later-btn').textContent).toMatch(/Send later/);
    expect(doc.querySelector('.composer .cf-later').hidden).toBe(true);
    expect(doc.querySelector('.composer .sched-link').textContent).toBe('Scheduled');
    doc.getElementById('compose-close').click();
    doc.querySelector('#msg-list .msg').click();
    await tick(window, 80);
    doc.querySelector('.mhead .reply-btn').click();
    await tick(window, 60);
    const box = doc.querySelector('#thread-body .reply-box');
    expect(box.querySelector('.attach-btn')).not.toBeNull();
    expect(box.querySelector('.later-btn')).not.toBeNull();
    const ro = await boot({ handler: standard(), mailboxes: MB.map((m) => ({ ...m, can_send: false })) });
    expect(ro.doc.getElementById('rail-sched').hidden).toBe(true);
  });

  test('Attach: the picker searches GET /api/documents; the caps disable rows and say why; a chip is name · size · ×; the payload carries attachments [{document_id}]; a draft keeps them', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openCompose(window, doc);
    await openPicker(window, doc);
    expect(doc.getElementById('doc-backdrop').classList.contains('open')).toBe(true);
    expect(doc.getElementById('doc-case-wrap').hidden).toBe(true); // no case on the composer: a plain search
    expect(doc.getElementById('doc-caps').textContent).toBe('3 files, 15 MB each, 15 MB together'); // the server's limits (identities.limits)
    expect(docRows(doc).map((li) => li.textContent)).toEqual(['Type part of a file name']);
    expect(calls.filter((c) => c.url === '/api/documents')).toEqual([]);
    type(window, doc.getElementById('doc-q'), 'o');
    await tick(window, 320);
    expect(calls.filter((c) => c.url === '/api/documents').map((c) => c.payload)).toEqual([{ limit: 20, q: 'o' }]);
    const rows = docRows(doc);
    expect(rows.map((li) => [li.querySelector('.l1').textContent, li.querySelector('.sz').textContent, li.getAttribute('aria-disabled')])).toEqual([
      ['One.pdf', '1 MB', null],
      ['Unknown.bin', 'size unknown', 'true'],
      ['The big archive', '20 MB', 'true'],
      ['Two.pdf', '2 MB', null],
    ]);
    expect(rows[1].title).toMatch(/Size unknown/);
    expect(rows[2].title).toMatch(/Over 15 MB/);
    rows[1].click();                                                  // disabled: nothing happens
    expect(chips(doc)).toEqual([]);
    rows[0].click();
    expect(doc.getElementById('doc-backdrop').classList.contains('open')).toBe(false);
    expect(chips(doc)).toEqual([['One.pdf', '1 MB']]);
    expect(doc.querySelector('.composer .files-row .yc-hint').textContent).toBe('1 of 3 · 1 MB of 15 MB');
    expect(doc.querySelector('.composer .attach-btn').textContent).toBe('Attach another…');
    await openPicker(window, doc);
    type(window, doc.getElementById('doc-q'), 'pdf');
    await tick(window, 320);
    const again = docRows(doc);
    expect(again[0].getAttribute('aria-disabled')).toBe('true');
    expect(again[0].title).toBe('Already attached');
    again[1].click();                                                 // Two.pdf
    expect(chips(doc)).toEqual([['One.pdf', '1 MB'], ['Two.pdf', '2 MB']]);
    fill(window, doc);
    doc.querySelector('.composer .send-btn').click();
    await tick(window, 40);
    const send = calls.find((c) => c.url === '/api/mail/send');
    expect(send.payload).toEqual({ mailbox_id: 1, to: ['client@outside.test'], subject: 'Hello', body_text: 'Hi there', attachments: [{ document_id: 1 }, { document_id: 4 }] });
    // a draft keeps the files; × removes one
    await openCompose(window, doc);
    await openPicker(window, doc);
    type(window, doc.getElementById('doc-q'), 'one');
    await tick(window, 320);
    docRows(doc)[0].click();
    doc.getElementById('compose-close').click();
    await openCompose(window, doc);
    expect(chips(doc)).toEqual([['One.pdf', '1 MB']]);
    doc.querySelector('.composer .achip button').click();
    expect(chips(doc)).toEqual([]);
    const payloadAfter = window.eval('composerPayload(state.composer)');
    expect(payloadAfter).toBeNull(); // no recipient yet — and no attachments key would ride along
  });

  test('Attach with a case on the composer: the picker opens on that case\'s files (link_type / link_id, no q) and unticks to a plain search', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    await openCompose(window, doc);
    window.eval("state.composer.caseSel = { case_id: 'C1', case_number: '26-111' }; paintCase(state.composer);");
    await openPicker(window, doc);
    expect(doc.getElementById('doc-case-wrap').hidden).toBe(false);
    expect(doc.getElementById('doc-case-lbl').textContent).toBe('Only files of 26-111');
    expect(doc.getElementById('doc-case-only').checked).toBe(true);
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/documents').map((c) => c.payload)).toEqual([{ limit: 20, link_type: 'case', link_id: 'C1' }]);
    expect(docRows(doc)).toHaveLength(4);
    type(window, doc.getElementById('doc-q'), 'two');
    await tick(window, 320);
    expect(calls.filter((c) => c.url === '/api/documents').pop().payload).toEqual({ limit: 20, q: 'two', link_type: 'case', link_id: 'C1' });
    doc.getElementById('doc-case-only').checked = false;
    doc.getElementById('doc-case-only').dispatchEvent(new window.Event('change'));
    await tick(window, 40);
    expect(calls.filter((c) => c.url === '/api/documents').pop().payload).toEqual({ limit: 20, q: 'two' });
    doc.getElementById('doc-cancel').click();
    expect(doc.getElementById('doc-backdrop').classList.contains('open')).toBe(false);
  });

  test('Send later: a firm-time pick becomes an instant (EST and EDT, held to Luxon); under the minimum is refused before any call; Schedule POSTs the same payload + send_at, closes, toasts, re-reads the list', async () => {
    const { window, doc, calls } = await boot({ handler: standard() });
    // the conversion, pure: Detroit is UTC-5 in December and UTC-4 in July
    expect(window.firmLocalToIso('2026-12-10T09:30')).toBe('2026-12-10T14:30:00.000Z');
    expect(window.firmLocalToIso('2026-07-04T09:30')).toBe('2026-07-04T13:30:00.000Z');
    expect(window.firmLocalToIso('')).toBeNull();
    // (an AMBIGUOUS wall clock — 01:30 on the fall-back night — is read either way; not a case here)
    for (const s of ['2026-12-10T09:30', '2026-07-04T23:59', '2026-03-08T03:30', '2026-03-09T03:00', '2026-11-01T03:00', '2026-11-01T00:30']) {
      expect(window.firmLocalToIso(s)).toBe(DateTime.fromISO(s, { zone: 'America/Detroit' }).toUTC().toISO());
    }
    await openCompose(window, doc);
    fill(window, doc);
    doc.querySelector('.composer .later-btn').click();
    const later = doc.querySelector('.composer .cf-later');
    expect(later.hidden).toBe(false);
    expect(later.querySelector('.yc-hint').textContent).toMatch(/Firm time \(America\/Detroit\) — at least 2 minutes from now, within 30 days/);
    const when = doc.querySelector('.composer .cf-when');
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00$/); // a default pick, on the hour, in firm time
    // under the minimum: refused here, nothing posted
    const soon = DateTime.now().setZone('America/Detroit').plus({ minutes: 1 });
    type(window, when, soon.toFormat("yyyy-LL-dd'T'HH:mm"));
    doc.querySelector('.composer .sched-btn').click();
    await tick(window, 20);
    expect(doc.querySelector('.composer .modal-err').textContent).toMatch(/at least 2 minutes from now/);
    expect(calls.filter((c) => c.url === '/api/mail/send/schedule')).toEqual([]);
    // a pick three days out at 09:30 firm time → that instant
    const pick = DateTime.now().setZone('America/Detroit').plus({ days: 3 }).set({ hour: 9, minute: 30, second: 0, millisecond: 0 });
    type(window, when, pick.toFormat("yyyy-LL-dd'T'HH:mm"));
    doc.querySelector('.composer .sched-btn').click();
    await tick(window, 60);
    const post = calls.find((c) => c.url === '/api/mail/send/schedule');
    expect(post.payload).toEqual({ mailbox_id: 1, to: ['client@outside.test'], subject: 'Hello', body_text: 'Hi there', send_at: pick.toUTC().toISO() });
    expect(doc.getElementById('compose-backdrop').classList.contains('open')).toBe(false);
    expect(doc.getElementById('toast').textContent).toMatch(/^Scheduled for .* from billing@firm\.test\./);
    expect(calls.filter((c) => c.url === '/api/mail/send/scheduled')).toHaveLength(1); // the list re-read after a schedule
    expect(doc.getElementById('rail-sched').textContent).toBe('Scheduled (1)');     // one pending of the two rows
    // a refused schedule keeps the composer with the server's words
    const { window: w2, doc: d2 } = await boot({ handler: standard({ 'POST /api/mail/send/schedule': () => { throw new Error('send_at must be at least 2 minutes from now'); } }) });
    await openCompose(w2, d2);
    fill(w2, d2);
    d2.querySelector('.composer .later-btn').click();
    type(w2, d2.querySelector('.composer .cf-when'), pick.toFormat("yyyy-LL-dd'T'HH:mm"));
    d2.querySelector('.composer .sched-btn').click();
    await tick(w2, 60);
    expect(d2.getElementById('compose-backdrop').classList.contains('open')).toBe(true);
    expect(d2.querySelector('.composer .modal-err').textContent).toMatch(/at least 2 minutes/);
    expect(d2.querySelector('.composer .send-btn').disabled).toBe(false);
  });

  test('Scheduled: the rows in firm time with a status pill; Cancel is two-step (Keep / Yes); Yes → DELETE; a 409 text shows as the server gives it', async () => {
    let refuse = null;
    const { window, doc, calls } = await boot({ handler: standard({
      'DELETE /api/mail/send/scheduled/5': () => { if (refuse) throw new Error(refuse); return { id: 5, status: 'cancelled' }; },
    }) });
    doc.getElementById('rail-sched').click();
    await tick(window, 60);
    expect(doc.getElementById('sched-backdrop').classList.contains('open')).toBe(true);
    expect(calls.filter((c) => c.url === '/api/mail/send/scheduled')).toHaveLength(1);
    expect(doc.getElementById('rail-sched').textContent).toBe('Scheduled (1)');
    const items = [...doc.querySelectorAll('#sched-list .sched-item')];
    expect(items.map((i) => [i.dataset.id, i.querySelector('.when').textContent, i.querySelector('.st').textContent])).toEqual([
      ['5', 'Thu, Dec 10, 9:30 AM', 'Scheduled'],
      ['6', 'Sun, Nov 15, 9:00 AM', 'Not sent'],
    ]);
    expect(items[0].querySelector('.what').textContent).toBe('Hello — to Client · from billing@firm.test · 1 file');
    expect(items[1].querySelector('.what').textContent).toMatch(/Old — to d@x\.test .* · This mailbox is switched off/);
    expect(items[1].querySelector('.sched-cancel')).toBeNull(); // only a pending one can be cancelled
    items[0].querySelector('.sched-cancel').click();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]); // one click is a question, not a cancel
    let row = doc.querySelector('#sched-list .sched-item[data-id="5"]');
    expect(row.querySelector('.sched-yes')).not.toBeNull();
    row.querySelector('.sched-no').click();
    row = doc.querySelector('#sched-list .sched-item[data-id="5"]');
    expect(row.querySelector('.sched-yes')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    // the 409 (another tab cancelled it, or it is going out): the server's text, in the modal
    refuse = 'This send is going out right now — it may already have gone. Check the mailbox\'s Sent folder.';
    row.querySelector('.sched-cancel').click();
    doc.querySelector('#sched-list .sched-yes').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/mail/send/scheduled/5']);
    expect(doc.getElementById('sched-msg').textContent).toBe(refuse);
    expect(doc.getElementById('sched-msg').classList.contains('show')).toBe(true);
    refuse = null;
    doc.querySelector('#sched-list .sched-cancel').click();
    doc.querySelector('#sched-list .sched-yes').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(doc.getElementById('toast').textContent).toMatch(/Cancelled/);
    expect(calls.filter((c) => c.url === '/api/mail/send/scheduled')).toHaveLength(3); // re-read after each answer
    doc.getElementById('sched-close').click();
    expect(doc.getElementById('sched-backdrop').classList.contains('open')).toBe(false);
    // Escape closes the list and the picker too
    doc.getElementById('rail-sched').click();
    await tick(window, 40);
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(doc.getElementById('sched-backdrop').classList.contains('open')).toBe(false);
  });
});
