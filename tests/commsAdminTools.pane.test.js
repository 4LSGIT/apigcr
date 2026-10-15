/**
 * @jest-environment node
 *
 * tests/commsAdminTools.pane.test.js — public/comms.html's admin-tools slot
 * (#commsAdminTools, the tabs row's right end), booted in jsdom against a stub
 * shell apiSend (the tests/phoneSPH.pane.test.js harness; in jsdom a top-level
 * window is its own parent, so window.apiSend IS the pane's P.apiSend):
 *   - "admin rights" = ARCHIVE admin (Fred's ruling, 2026-10-15): GET
 *     /api/comms-archive/admin → archive_admin, read ONCE per page load — never
 *     the audited no-transcribe GET as a probe. A soft, cosmetic gate: the
 *     button shows on Phone for an archive admin only — hidden on Email and
 *     Team, for a non-admin, and when the flag read fails;
 *   - a click opens the shared dialog (public/js/ycNoTranscribe.js); a 403 from
 *     the dialog's own GET (the real gate) renders inside it;
 *   - one registry entry adds a tool;
 *   - the slot is NOT a tab: outside the tablist, no role=tab; the button
 *     carries its name in aria-label + title, its label in .cat-label (the
 *     phone breakpoint shows the icon only).
 * The dialog's own behaviour: tests/commsNoTranscribe.pane.test.js.
 * Mutation-checked (the COMMSADM report lists each).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const COMMS = read('public/comms.html');
const NOTX = read('public/js/ycNoTranscribe.js');
const PURIFY = read('public/js/vendor/purify-3.4.16.min.js');
const RENDER = read('public/js/mailRender.js');
const COLOR = read('public/js/mailboxColor.js');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 40) => new Promise((r) => w.setTimeout(r, ms));

function pageParts(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return { bodyHtml: bodyHtml.replace(/<script[\s\S]*?<\/script>/g, ''), inline };
}

/** admin: the flag route's answer — true / false, or an Error to throw (the read fails); listError: the list GET's refusal. */
async function boot({ admin = true, listError = null } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>',
    { url: 'https://app.4lsg.com/comms.html', runScripts: 'dangerously', pretendToBeVisual: true });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
  const D = window.HTMLDialogElement && window.HTMLDialogElement.prototype;
  if (D && typeof D.showModal !== 'function') D.showModal = function () { this.setAttribute('open', ''); };
  if (D && typeof D.close !== 'function') D.close = function () { this.removeAttribute('open'); };
  window.firmData = { firmTimezone: 'America/Detroit', currentUser: { user: 1, user_auth: 'authorized', roles: 'admin,staff,attorney' },
    users: [{ user: 1, user_name: 'SS', user_type: 1, active: true }] };
  const calls = [];
  window.apiSend = async (u, method = 'GET', payload = null) => {
    calls.push({ url: u, method, payload });
    if (u === '/api/comms-archive/admin') {
      if (admin instanceof Error) throw admin;
      return { status: 'success', archive_admin: admin };
    }
    if (u === '/api/comms-archive/no-transcribe' && method === 'GET') {
      if (listError) throw new Error(listError);
      return { status: 'success', entries: [] };
    }
    if (u === '/api/mail/mailboxes') return { mailboxes: [], viewer: { su: false, role: null, can_send: false } };
    if (u === '/api/mail/views') return { views: [] };
    if (u === '/api/mail/views/counts') return { counts: {} };
    if (u === '/api/mail/messages') return { messages: [], next_cursor: null };
    if (u === '/api/phone-lines/readable') return { viewer: { su: false }, lines: [] };
    throw new Error(`unexpected ${method} ${u}`);
  };
  const { bodyHtml, inline } = pageParts(COMMS);
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  window.document.body.innerHTML = bodyHtml;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [PURIFY, RENDER, COLOR, NOTX, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 80);
  const doc = window.document;
  const tab = async (k) => { doc.getElementById('tab-' + k).click(); await tick(window, 60); };
  const slot = () => doc.getElementById('commsAdminTools');
  const shown = () => (slot().hidden ? [] : [...slot().querySelectorAll('button')].map((b) => b.id));
  return { window, doc, calls, errors, tab, slot, shown };
}

const flagReads = (calls) => calls.filter((c) => c.url === '/api/comms-archive/admin');
const listReads = (calls) => calls.filter((c) => c.url.startsWith('/api/comms-archive/no-transcribe'));

describe('comms.html — the admin-tools slot', () => {
  test('an archive admin: hidden on Email (the start) and Team, shown on Phone; the flag is read once, the list never', async () => {
    const env = await boot({ admin: true });
    const { doc, calls, errors, tab, shown } = env;
    expect(shown()).toEqual([]);                                                 // Email
    expect(flagReads(calls).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/comms-archive/admin']);
    await tab('phone');
    expect(shown()).toEqual(['cat-notx']);
    await tab('team');
    expect(shown()).toEqual([]);
    await tab('email');
    expect(shown()).toEqual([]);
    await tab('phone');
    expect(shown()).toEqual(['cat-notx']);
    expect(flagReads(calls)).toHaveLength(1);                                    // once per page load
    expect(listReads(calls)).toEqual([]);                                        // never probed with the audited list read
    const b = doc.getElementById('cat-notx');
    expect(b.getAttribute('aria-label')).toBe('Do-not-transcribe');
    expect(b.getAttribute('title')).toBe('Numbers whose calls are archived but never transcribed');
    expect(b.querySelector('.cat-label').textContent).toBe('Do-not-transcribe');
    expect(b.querySelector('i.fa-microphone-slash')).not.toBeNull();
    expect(errors).toEqual([]);
  });

  test('a non-admin (archive_admin false, or not strictly true): hidden on every tab, Phone included', async () => {
    for (const admin of [false, 'true', 1, null]) {
      const env = await boot({ admin });
      for (const k of ['email', 'phone', 'team', 'phone']) {
        await env.tab(k);
        expect([admin, k, env.shown()]).toEqual([admin, k, []]);
      }
      expect(env.slot().hidden).toBe(true);
      expect(listReads(env.calls)).toEqual([]);
      expect(env.errors).toEqual([]);
    }
  });

  test('the flag read fails: hidden on Phone, no error escapes the page', async () => {
    const env = await boot({ admin: new Error('Network down') });
    expect(flagReads(env.calls)).toHaveLength(1);
    await env.tab('phone');
    expect(env.shown()).toEqual([]);
    expect(env.slot().hidden).toBe(true);
    expect(env.errors).toEqual([]);
  });

  test('a click opens the shared dialog, which reads the list', async () => {
    const env = await boot();
    await env.tab('phone');
    expect(env.doc.getElementById('noTxDialog')).toBeNull();
    env.doc.getElementById('cat-notx').click();
    await tick(env.window, 60);
    expect(env.doc.getElementById('noTxDialog').open).toBe(true);
    expect(listReads(env.calls).map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/comms-archive/no-transcribe']);
    expect(env.doc.getElementById('noTxBy').value).toBe('1');                   // the page's firmData reached it
    expect(env.errors).toEqual([]);
  });

  test('a 403 from the dialog\'s GET (the real gate — e.g. removed from the list since the page loaded) renders in the dialog', async () => {
    const env = await boot({ admin: true, listError: 'Archive admins only' });
    await env.tab('phone');
    env.doc.getElementById('cat-notx').click();
    await tick(env.window, 60);
    const { doc } = env;
    expect(doc.getElementById('noTxDialog').open).toBe(true);
    expect(doc.getElementById('noTxMsg').textContent).toBe("Couldn't load the list: Archive admins only");
    expect(doc.getElementById('noTxMsg').className).toBe('result err');
    expect([...doc.querySelectorAll('#noTxBody tr')].map((tr) => tr.textContent.trim())).toEqual(['No numbers on the list.']);
    expect(env.errors).toEqual([]);
  });

  test('one registry entry adds a tool: it paints on its tab, beside the others', async () => {
    const env = await boot();
    const sc = env.doc.createElement('script');
    sc.textContent = "ADMIN_TOOLS.push({ id: 'acc', label: 'Phone access', icon: 'fa-key', when: (c) => c.tab === 'phone' && c.isArchiveAdmin, open: () => { window.__accOpened = 1; } });";
    env.doc.body.appendChild(sc);
    await env.tab('phone');
    expect(env.shown()).toEqual(['cat-notx', 'cat-acc']);
    env.doc.getElementById('cat-acc').click();
    expect(env.window.__accOpened).toBe(1);
    await env.tab('email');
    expect(env.shown()).toEqual([]);
  });

  test('the slot is not a tab: outside the tablist, which holds tabs only; at the phone breakpoint the label hides', () => {
    const { bodyHtml } = pageParts(COMMS);
    const dom = new JSDOM(`<!DOCTYPE html><body>${bodyHtml}</body>`);
    DOMS.push(dom);
    const doc = dom.window.document;
    const slot = doc.getElementById('commsAdminTools');
    const list = doc.querySelector('[role="tablist"]');
    expect(doc.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(list.contains(slot)).toBe(false);
    expect([...list.children].map((c) => c.getAttribute('role'))).toEqual(['tab', 'tab', 'tab']);
    expect(slot.parentElement).toBe(list.parentElement);                         // the same row, after the tabs
    expect(slot.previousElementSibling).toBe(list);
    expect(slot.parentElement.classList.contains('tabs')).toBe(true);
    expect(slot.getAttribute('role')).toBe('toolbar');
    expect(slot.hidden).toBe(true);                                              // empty until painted
    // ≤768px a tool is its icon; the flex child that pushes right must not shrink (CLAUDE.md flex pitfall)
    expect(COMMS).toMatch(/@media \(max-width: 768px\) \{ \.comms-admin-tools \.cat-label \{ display: none; \} \}/);
    expect(COMMS).toMatch(/\.comms-admin-tools \{ margin-left: auto;[^}]*flex: 0 0 auto;/);
  });
});
