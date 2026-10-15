/**
 * @jest-environment node
 *
 * tests/commsNoTranscribe.pane.test.js — the do-not-transcribe dialog (comms
 * archive R9): ONE module, public/js/ycNoTranscribe.js, hosted by
 *   - public/connections.html — Phone Lines → Do-not-transcribe (left of "+ Add Line");
 *   - public/comms.html — the Phone tab's admin-tools slot (archive admins, a
 *     soft gate; the slot itself: tests/commsAdminTools.pane.test.js).
 * Each host is booted in jsdom against a stub shell apiSend (the
 * tests/phoneSPH.pane.test.js harness; in jsdom a top-level window is its own
 * parent, so window.apiSend IS the pane's P.apiSend), with the module loaded
 * the way the page's <script src> would. On BOTH hosts:
 *   - the button opens the dialog, which GETs the list and renders
 *     [✕] | phone | note | requested by (all text);
 *   - "Requested by" offers active staff only (firmData user_type && active
 *     !== false), the signed-in user selected; else a leading "Me";
 *   - Add POSTs at once and repaints from the response; a refusal keeps what
 *     was typed; ✕ asks first, then DELETEs at once; a 403 shows in the dialog;
 *   - the hint is a .yc-hint, the labels .yc-flabel — no inline style.
 * And the module's own contract: both hosts load it (no copy left in a page),
 * every CSS rule is scoped through #noTxDialog (wins on specificity), one
 * dialog + one style however often it opens.
 * Mutation-checked (the NOTX and COMMSADM reports list each).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const CONN = read('public/connections.html');
const COMMS = read('public/comms.html');
const NOTX = read('public/js/ycNoTranscribe.js');
const PURIFY = read('public/js/vendor/purify-3.4.16.min.js');
const RENDER = read('public/js/mailRender.js');
const COLOR = read('public/js/mailboxColor.js');

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

/** Each host: its page, the libs its <script src> tags load, its own routes, and how its button opens the dialog. */
const HOSTS = {
  connections: {
    url: 'https://app.4lsg.com/connections.html',
    html: CONN,
    libs: [NOTX],
    routes(u) {
      if (u === '/api/credentials') return { credentials: [] };
      if (u === '/api/email-credentials') return { email_credentials: [] };
      if (u === '/api/phone-lines/admin') return { phone_lines: [], providers: {} };
      return undefined;
    },
    async open(env) {
      env.doc.getElementById('phone-notx').click();
      await tick(env.window, 60);
    },
  },
  comms: {
    url: 'https://app.4lsg.com/comms.html',
    html: COMMS,
    libs: [PURIFY, RENDER, COLOR, NOTX],
    routes(u) {
      if (u === '/api/comms-archive/admin') return { status: 'success', archive_admin: true };
      if (u === '/api/mail/mailboxes') return { mailboxes: [], viewer: { su: false, role: null, can_send: false } };
      if (u === '/api/mail/views') return { views: [] };
      if (u === '/api/mail/views/counts') return { counts: {} };
      if (u === '/api/mail/messages') return { messages: [], next_cursor: null };
      if (u === '/api/phone-lines/readable') return { viewer: { su: false }, lines: [] };
      return undefined;
    },
    async open(env) {
      env.doc.getElementById('tab-phone').click();
      await tick(env.window, 60);
      env.doc.getElementById('cat-notx').click();
      await tick(env.window, 60);
    },
  },
};

function pageParts(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const head = (noComments.match(/<head>([\s\S]*?)<\/head>/) || [])[1] || '';
  const srcs = [...head.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);   // real tags in <head>, not a mention in a comment
  return { bodyHtml: bodyHtml.replace(/<script[\s\S]*?<\/script>/g, ''), inline, srcs };
}

async function boot(hostName, { handler, confirmAnswer = true, currentUser = 6 }) {
  const host = HOSTS[hostName];
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>',
    { url: host.url, runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  const D = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
  if (D && typeof D.showModal !== 'function') D.showModal = function () { this.setAttribute('open', ''); };
  if (D && typeof D.close !== 'function') D.close = function () { this.removeAttribute('open'); };
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user: currentUser, user_auth: 'authorized', roles: 'it,admin,su' }, users: fresh(USERS) };
  const calls = [];
  window.apiSend = async (u, method = 'GET', payload = null) => {
    calls.push({ url: u, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    const own = host.routes(u, method);
    if (own !== undefined) return own;
    return handler(u, method, payload);
  };
  const confirms = [];
  window.confirm = (m) => { confirms.push(m); return confirmAnswer; };
  const { bodyHtml, inline } = pageParts(host.html);
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  window.document.body.innerHTML = bodyHtml;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [...host.libs, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  return { window, doc: window.document, calls, errors, confirms, host };
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

const openDialog = (env) => env.host.open(env);
const rowsText = (doc) => [...doc.querySelectorAll('#noTxBody tr')].map((tr) => [...tr.cells].map((td) => td.textContent.trim()));
const listCalls = (calls) => calls.filter((c) => c.url.startsWith('/api/comms-archive/no-transcribe'));

describe('connections.html — the Phone Lines button', () => {
  test('sits left of "+ Add Line"; nothing list-shaped is fetched until it is clicked', async () => {
    const env = await boot('connections', { handler: listHandler({ entries: fresh(ENTRIES) }) });
    const btn = env.doc.getElementById('phone-notx');
    expect(btn.textContent).toBe('Do-not-transcribe');
    expect(btn.nextElementSibling.id).toBe('phone-new');
    expect(env.calls.some((c) => c.url.startsWith('/api/comms-archive'))).toBe(false);
    expect(env.doc.getElementById('noTxDialog')).toBeNull();                      // built on first open
    await openDialog(env);
    expect(env.doc.getElementById('noTxDialog').open).toBe(true);
  });
});

describe.each(Object.keys(HOSTS))('%s.html — the do-not-transcribe dialog', (hostName) => {
  test('the button opens the dialog, GETs the list and renders the four columns as text', async () => {
    const state = { entries: fresh(ENTRIES) };
    const env = await boot(hostName, { handler: listHandler(state) });
    const { doc, window, calls, errors } = env;
    expect(listCalls(calls)).toEqual([]);                                        // nothing until it is opened
    await openDialog(env);
    expect(doc.getElementById('noTxDialog').open).toBe(true);
    expect(listCalls(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/comms-archive/no-transcribe']);
    expect(rowsText(doc)).toEqual([
      ['✕', '(248) 555-1234', `personal ${EVIL}`, `Eve ${EVIL}`],
      ['✕', '(313) 555-0199', '', 'user #9'],
    ]);
    expect(doc.querySelector('#noTxBody img')).toBeNull();                       // note AND requested-by are text
    expect(doc.querySelector('#noTxBy img')).toBeNull();
    expect(window.__pwned).toBeUndefined();
    expect([...doc.querySelectorAll('#noTxDialog thead th')].map((th) => th.textContent)).toEqual(['', 'Phone', 'Note', 'Requested by']);
    expect(doc.querySelector('#noTxBody button.notx-x[data-id="7"]').getAttribute('aria-label')).toBe('Remove (248) 555-1234');
    expect(errors).toEqual([]);
  });

  test('"Requested by" offers active staff only, the signed-in admin selected; hint and labels by class, no inline style', async () => {
    const env = await boot(hostName, { handler: listHandler({ entries: [] }) });
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
    expect([...doc.querySelectorAll('#noTxDialog label')].map((l) => [l.className, l.textContent, l.getAttribute('for')]))
      .toEqual([['yc-flabel', 'Phone', 'noTxPhone'], ['yc-flabel', 'Reason', 'noTxNote'], ['yc-flabel', 'Requested by', 'noTxBy']]);
    expect(doc.querySelectorAll('#noTxDialog [style]')).toHaveLength(0);
    expect(rowsText(doc)).toEqual([['No numbers on the list.']]);
  });

  test('Add POSTs at once and repaints from the response; a refusal keeps what was typed', async () => {
    const state = { entries: fresh(ENTRIES) };
    const env = await boot(hostName, { handler: listHandler(state) });
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
    const no = await boot(hostName, { handler: listHandler(state), confirmAnswer: false });
    await openDialog(no);
    no.doc.querySelector('#noTxBody button.notx-x[data-id="7"]').click();
    await tick(no.window, 40);
    expect(no.confirms).toEqual([expect.stringMatching(/^Remove \(248\) 555-1234 from the do-not-transcribe list\?/)]);
    expect(no.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    expect(rowsText(no.doc)).toHaveLength(2);

    const yes = await boot(hostName, { handler: listHandler(state) });
    await openDialog(yes);
    yes.doc.querySelector('#noTxBody button.notx-x[data-id="7"]').click();
    await tick(yes.window, 60);
    expect(yes.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual(['/api/comms-archive/no-transcribe/7']);
    expect(rowsText(yes.doc)).toEqual([['✕', '(313) 555-0199', '', 'user #9']]);
    expect(yes.doc.getElementById('noTxMsg').textContent).toBe('Removed (248) 555-1234.');
  });

  test('signed-in user not among active staff: a leading "Me" is selected and no requested_by is sent (the server records the caller)', async () => {
    const state = { entries: [] };
    const env = await boot(hostName, { handler: listHandler(state), currentUser: 41 });
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
    const env2 = await boot(hostName, { handler: listHandler({ entries: [] }) });
    await openDialog(env2);
    expect([...env2.doc.getElementById('noTxBy').options].some((o) => o.value === '')).toBe(false);
  });

  test('a refused list read (403) shows in the dialog; Close closes it; a reopen starts clean, with one dialog and one style', async () => {
    const state = { entries: [], getError: 'Archive admins only' };
    const env = await boot(hostName, { handler: listHandler(state) });
    await openDialog(env);
    const { doc, window } = env;
    expect(doc.getElementById('noTxMsg').textContent).toBe("Couldn't load the list: Archive admins only");
    expect(rowsText(doc)).toEqual([['No numbers on the list.']]);
    doc.getElementById('noTxPhone').value = 'typed';
    doc.getElementById('noTxClose').click();
    expect(doc.getElementById('noTxDialog').open).toBe(false);
    delete state.getError;
    state.entries = fresh(ENTRIES);
    await openDialog(env);
    expect(doc.getElementById('noTxDialog').open).toBe(true);
    expect(doc.getElementById('noTxMsg').textContent).toBe('');
    expect(doc.getElementById('noTxPhone').value).toBe('');
    expect(rowsText(doc)).toHaveLength(2);
    expect(doc.querySelectorAll('#noTxDialog')).toHaveLength(1);
    expect(doc.querySelectorAll('.notx-add')).toHaveLength(1);                   // the one dialog, reused
    expect(doc.querySelectorAll('style#ycNoTxStyle')).toHaveLength(1);
    expect(window.document.head.querySelector('style#ycNoTxStyle')).not.toBeNull();
  });
});

describe('public/js/ycNoTranscribe.js — one copy, scoped CSS', () => {
  test('both hosts load the module by <script src>, and neither keeps a copy of the dialog', () => {
    for (const [name, html] of [['connections.html', CONN], ['comms.html', COMMS]]) {
      expect([name, pageParts(html).srcs.includes('/js/ycNoTranscribe.js')]).toEqual([name, true]);
      expect([name, /noTxDialog|noTxAdd|noTxRenderList|#noTx/.test(html)]).toEqual([name, false]);
    }
  });

  test('every CSS rule is scoped through #noTxDialog (it wins on specificity, not load order)', async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', { runScripts: 'dangerously' });
    DOMS.push(dom);
    const w = dom.window;
    const D = w.HTMLDialogElement.prototype;
    if (typeof D.showModal !== 'function') D.showModal = function () { this.setAttribute('open', ''); };
    const sc = w.document.createElement('script');
    sc.textContent = NOTX;
    w.document.body.appendChild(sc);
    w.ycNoTranscribe.open({ api: async () => ({ entries: [] }), firmData: null });
    const style = w.document.getElementById('ycNoTxStyle');
    const selectors = [...style.sheet.cssRules].flatMap((r) => {
      expect(r.type).toBe(1);                                                    // plain style rules only (no @media escaping the scope)
      return r.selectorText.split(',').map((x) => x.trim());
    });
    expect(selectors.length).toBeGreaterThan(30);
    expect(selectors.filter((x) => !/^#noTxDialog(?![\w-])/.test(x))).toEqual([]);
    // the look the dialog needs from a host is all restated here: box, inputs, buttons, table, result
    for (const need of ['#noTxDialog', '#noTxDialog input', '#noTxDialog .btn', '#noTxDialog .btn.primary', '#noTxDialog table.list',
      '#noTxDialog .result.err', '#noTxDialog .yc-flabel', '#noTxDialog .yc-hint', '#noTxDialog::backdrop']) {
      expect([need, selectors.includes(need)]).toEqual([need, true]);
    }
    await expect(w.ycNoTranscribe.open({})).rejects.toThrow(/api must be a function/);
    expect(Object.isFrozen(w.ycNoTranscribe)).toBe(true);
  });
});
