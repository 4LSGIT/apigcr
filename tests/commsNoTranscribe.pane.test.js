/**
 * @jest-environment node
 *
 * tests/commsNoTranscribe.pane.test.js — public/connections.html Phone Lines →
 * Do-not-transcribe (comms archive R9), booted in jsdom against a stub shell
 * apiSend (the tests/phoneSPH.pane.test.js harness; in jsdom a top-level
 * window is its own parent, so window.apiSend IS the pane's P.apiSend):
 *   - the button sits just left of "+ Add Line" and opens the dialog, which
 *     GETs the list and renders [✕] | phone | note | requested by (all text);
 *   - "Requested by" offers active staff only (firmData user_type && active
 *     !== false), the signed-in user selected;
 *   - Add POSTs at once and repaints from the response; a refusal keeps what
 *     was typed; ✕ asks first, then DELETEs at once; a 403 shows in the dialog;
 *   - the hint is a .yc-hint, the labels .yc-flabel — no inline style.
 * Mutation-checked (the NOTX report lists each).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const CONN = fs.readFileSync(path.join(__dirname, '..', 'public/connections.html'), 'utf8');
const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));
const fresh = (v) => JSON.parse(JSON.stringify(v));
const EVIL = '<img src=x onerror="window.top.__pwned=1">';

const USERS = [
  { user: 0, user_name: 'Automation', user_type: 0, active: true },
  { user: 1, user_name: 'SS', user_type: 1, active: true },
  { user: 6, user_name: 'Fred', user_type: 1, active: true },
  { user: 9, user_name: 'Gone', user_type: 1, active: false },
  { user: 22, user_name: 'Rena', user_type: 1, active: true },
  { user: 23, user_name: `Eve ${EVIL}`, user_type: 1, active: true },
];
const ENTRIES = [
  { id: 7, phone: '2485551234', note: `personal ${EVIL}`, created_by: 23, created_by_name: `Eve ${EVIL}`, created_at: '2026-10-15T10:00:00.000Z' },
  { id: 3, phone: '3135550199', note: null, created_by: 9, created_by_name: null, created_at: '2026-10-14T10:00:00.000Z' },
];

async function boot({ handler, confirmAnswer = true, currentUser = 6 }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>',
    { url: 'https://app.4lsg.com/connections.html', runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  const D = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
  if (D && typeof D.showModal !== 'function') D.showModal = function () { this.setAttribute('open', ''); };
  if (D && typeof D.close !== 'function') D.close = function () { this.removeAttribute('open'); };
  window.firmData = { currentUser: { user: currentUser, user_auth: 'authorized', roles: 'it,admin,su' }, users: fresh(USERS) };
  const calls = [];
  window.apiSend = async (u, method = 'GET', payload = null) => {
    calls.push({ url: u, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    if (u === '/api/credentials') return { credentials: [] };
    if (u === '/api/email-credentials') return { email_credentials: [] };
    if (u === '/api/phone-lines/admin') return { phone_lines: [], providers: {} };
    return handler(u, method, payload);
  };
  const confirms = [];
  window.confirm = (m) => { confirms.push(m); return confirmAnswer; };
  const noComments = CONN.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const sc = window.document.createElement('script');
  sc.textContent = inline[0];
  window.document.body.appendChild(sc);
  await tick(window, 80);
  return { window, doc: window.document, calls, errors, confirms };
}

/** A stub of the three routes over an in-memory list. */
function listHandler(state) {
  return (url, method, payload) => {
    if (url === '/api/comms-archive/no-transcribe' && method === 'GET') {
      if (state.getError) throw new Error(state.getError);
      return { status: 'success', entries: fresh(state.entries) };
    }
    if (url === '/api/comms-archive/no-transcribe' && method === 'POST') {
      if (state.postError) throw new Error(state.postError);
      const entry = { id: 40, phone: '5865550101', note: payload.note.trim() || null, created_by: Number(payload.requested_by),
        created_by_name: 'Rena', created_at: '2026-10-15T11:00:00.000Z' };
      state.entries.unshift(entry);
      return { status: 'success', entry: fresh(entry) };
    }
    let m;
    if ((m = /^\/api\/comms-archive\/no-transcribe\/(\d+)$/.exec(url)) && method === 'DELETE') {
      const e = state.entries.find((x) => x.id === Number(m[1]));
      state.entries = state.entries.filter((x) => x.id !== Number(m[1]));
      return { status: 'success', entry: fresh(e) };
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

async function openDialog(env) {
  env.doc.getElementById('phone-notx').click();
  await tick(env.window, 60);
}
const rowsText = (doc) => [...doc.querySelectorAll('#noTxBody tr')].map((tr) => [...tr.cells].map((td) => td.textContent.trim()));

describe('connections.html — Phone Lines → Do-not-transcribe', () => {
  test('the button sits left of "+ Add Line"; it opens the dialog, GETs the list and renders the four columns as text', async () => {
    const state = { entries: fresh(ENTRIES) };
    const env = await boot({ handler: listHandler(state) });
    const { doc, window, calls, errors } = env;
    const btn = doc.getElementById('phone-notx');
    expect(btn.textContent).toBe('Do-not-transcribe');
    expect(btn.nextElementSibling.id).toBe('phone-new');
    expect(calls.some((c) => c.url.startsWith('/api/comms-archive'))).toBe(false);    // nothing until it is opened
    await openDialog(env);
    expect(doc.getElementById('noTxDialog').open).toBe(true);
    expect(calls.filter((c) => c.url.startsWith('/api/comms-archive')).map((c) => `${c.method} ${c.url}`))
      .toEqual(['GET /api/comms-archive/no-transcribe']);
    expect(rowsText(doc)).toEqual([
      ['✕', '(248) 555-1234', `personal ${EVIL}`, `Eve ${EVIL}`],
      ['✕', '(313) 555-0199', '', 'user #9'],
    ]);
    expect(doc.querySelector('#noTxBody img')).toBeNull();                       // note AND requested-by are text
    expect(doc.querySelector('#noTxBy img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect([...doc.querySelectorAll('#noTxDialog thead th')].map((th) => th.textContent)).toEqual(['', 'Phone', 'Note', 'Requested by']);
    expect(errors).toEqual([]);
  });

  test('"Requested by" offers active staff only, the signed-in admin selected; hint and labels by class, no inline style', async () => {
    const env = await boot({ handler: listHandler({ entries: [] }) });
    await openDialog(env);
    const { doc } = env;
    const sel = doc.getElementById('noTxBy');
    expect([...sel.options].map((o) => [o.value, o.textContent])).toEqual([['1', 'SS'], ['6', 'Fred'], ['22', 'Rena'], ['23', `Eve ${EVIL}`]]);
    expect(sel.value).toBe('6');
    expect(doc.querySelector('#noTxBy img')).toBeNull();
    expect(env.window.__pwned).toBeUndefined();
    const hint = doc.querySelector('#noTxDialog .yc-hint');
    expect(hint.textContent).toMatch(/still archived and playable, but are not sent for transcription/);
    expect(hint.textContent).toMatch(/does not touch transcripts that already exist/);
    expect(hint.textContent).toMatch(/Removing a number lets future calls be transcribed; calls already skipped stay skipped/);
    expect([...doc.querySelectorAll('#noTxDialog label')].map((l) => [l.className, l.textContent]))
      .toEqual([['yc-flabel', 'Phone'], ['yc-flabel', 'Reason'], ['yc-flabel', 'Requested by']]);
    expect(doc.querySelectorAll('#noTxDialog [style]')).toHaveLength(0);
    expect(rowsText(doc)).toEqual([['No numbers on the list.']]);
  });

  test('Add POSTs at once and repaints from the response; a refusal keeps what was typed', async () => {
    const state = { entries: fresh(ENTRIES) };
    const env = await boot({ handler: listHandler(state) });
    await openDialog(env);
    const { doc, window, calls } = env;
    doc.getElementById('noTxPhone').value = '(586) 555-0101';
    doc.getElementById('noTxNote').value = ' wife ';
    doc.getElementById('noTxBy').value = '22';
    doc.getElementById('noTxAdd').click();
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.url, c.payload]))
      .toEqual([['/api/comms-archive/no-transcribe', { phone: '(586) 555-0101', note: ' wife ', requested_by: '22' }]]);
    expect(rowsText(doc)[0]).toEqual(['✕', '(586) 555-0101', 'wife', 'Rena']);
    expect(rowsText(doc)).toHaveLength(3);
    expect(doc.getElementById('noTxPhone').value).toBe('');
    expect(doc.getElementById('noTxMsg').textContent).toBe('Added (586) 555-0101.');

    state.postError = 'That number is already on the list';
    doc.getElementById('noTxPhone').value = '2485551234';
    doc.getElementById('noTxNote').value = 'again';
    doc.getElementById('noTxPhone').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick(window, 60);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    expect(doc.getElementById('noTxMsg').textContent).toBe('That number is already on the list');
    expect(doc.getElementById('noTxMsg').className).toBe('result err');
    expect(doc.getElementById('noTxPhone').value).toBe('2485551234');
    expect(doc.getElementById('noTxNote').value).toBe('again');
    expect(rowsText(doc)).toHaveLength(3);

    doc.getElementById('noTxPhone').value = '  ';
    doc.getElementById('noTxAdd').click();
    await tick(window, 30);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);             // empty: no call
  });

  test('✕ asks first: No sends nothing; Yes DELETEs at once and the row goes', async () => {
    const state = { entries: fresh(ENTRIES) };
    const no = await boot({ handler: listHandler(state), confirmAnswer: false });
    await openDialog(no);
    no.doc.querySelector('#noTxBody button.notx-x[data-id="7"]').click();
    await tick(no.window, 40);
    expect(no.confirms).toEqual([expect.stringMatching(/^Remove \(248\) 555-1234 from the do-not-transcribe list\?/)]);
    expect(no.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(rowsText(no.doc)).toHaveLength(2);

    const yes = await boot({ handler: listHandler(state) });
    await openDialog(yes);
    yes.doc.querySelector('#noTxBody button.notx-x[data-id="7"]').click();
    await tick(yes.window, 60);
    expect(yes.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/comms-archive/no-transcribe/7']);
    expect(rowsText(yes.doc)).toEqual([['✕', '(313) 555-0199', '', 'user #9']]);
    expect(yes.doc.getElementById('noTxMsg').textContent).toBe('Removed (248) 555-1234.');
  });

  test('signed-in user not among active staff: a leading "Me" is selected and no requested_by is sent (the server records the caller)', async () => {
    const state = { entries: [] };
    const env = await boot({ handler: listHandler(state), currentUser: 41 });
    await openDialog(env);
    const { doc, window, calls } = env;
    const sel = doc.getElementById('noTxBy');
    expect([...sel.options].map((o) => [o.value, o.textContent])[0]).toEqual(['', 'Me']);
    expect(sel.options).toHaveLength(5);
    expect(sel.value).toBe('');
    doc.getElementById('noTxPhone').value = '5865550101';
    doc.getElementById('noTxAdd').click();
    await tick(window, 60);
    const post = calls.find((c) => c.method === 'POST');
    expect(post.payload).toEqual({ phone: '5865550101', note: '' });               // requested_by absent
    // listed again (the normal case): no "Me" — the signed-in admin's own option instead
    const env2 = await boot({ handler: listHandler({ entries: [] }) });
    await openDialog(env2);
    expect([...env2.doc.getElementById('noTxBy').options].some((o) => o.value === '')).toBe(false);
  });

  test('a refused list read (403) shows in the dialog; Close closes it', async () => {
    const env = await boot({ handler: listHandler({ entries: [], getError: 'Archive admins only' }) });
    await openDialog(env);
    const { doc } = env;
    expect(doc.getElementById('noTxMsg').textContent).toBe("Couldn't load the list: Archive admins only");
    expect(rowsText(doc)).toEqual([['No numbers on the list.']]);
    doc.getElementById('noTxClose').click();
    expect(doc.getElementById('noTxDialog').open).toBe(false);
  });
});
