/**
 * Mailboxes admin pane (public/mailboxAdmin.html) — the S3-R "send-as address"
 * mode, booted in jsdom against a mocked shell apiSend (the
 * tests/mailboxS2.adminColor.test.js harness, same contract).
 *
 * What this pins (each mutation-checked — break it, watch a test fail):
 *   - the create form's type toggle: alias mode hides Connection + Ingest,
 *     shows the parent picker (non-alias boxes only) + the label, and Save
 *     POSTs {address, alias_of, alias_label, …} and NO connection / ingest
 *     fields (the server refuses those on an alias — the pane must not send
 *     them); a missing parent is an inline error, nothing POSTs.
 *   - editing an alias: the type section is gone, the parent picker shows
 *     the current box (re-pointing PATCHes alias_of alone — mailboxes are
 *     never deleted, so there is no delete + recreate), the label PATCHes
 *     alone; the list row says "send-as of <parent>".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public/mailboxAdmin.html'), 'utf8');
const COLOR = fs.readFileSync(path.join(ROOT, 'public/js/mailboxColor.js'), 'utf8');

const DOMS = [];
afterEach(() => { DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }); });
const tick = (w, ms = 30) => new Promise((r) => w.setTimeout(r, ms));

const SU_ACCESS = { can_read: true, can_send: true, can_manage: true, su: true };
const box = (id, over = {}) => ({
  id, address: `box${id}@firm.test`, domain: 'firm.test', display_name: null, color: null,
  imap_host: 'imap.firm.test', imap_port: 993, imap_user: `box${id}`, has_secret: true,
  send_credential_id: null, send_credential_email: null, ingest_enabled: true,
  ingest_folders: { INBOX: { emit_to_rules: true } }, ingest_state: null, active: true, grant_count: 0,
  alias_of: null, alias_label: null, alias_of_address: null,
  access: SU_ACCESS, ...over,
});

async function boot({ rows, handler = () => ({}) }) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://app.4lsg.com/mailboxAdmin.html', runScripts: 'dangerously', pretendToBeVisual: true,
  });
  DOMS.push(dom);
  const { window } = dom;
  window.Element.prototype.scrollIntoView = function () {};
  const calls = [];
  window.apiSend = async (url, method = 'GET', payload = null) => {
    calls.push({ url, method, payload: payload == null ? null : JSON.parse(JSON.stringify(payload)) });
    const over = handler(url, method, payload);
    if (over !== undefined && over !== null && !(typeof over === 'object' && !Object.keys(over).length)) return over;
    if (url === '/api/mailboxes' && method === 'GET') return { mailboxes: rows, viewer: { su: true } };
    if (url === '/api/users') return { users: [] };
    if (url === '/api/email-credentials') return { email_credentials: [{ id: 6, email: 'it@firm.test', provider: 'gmail' }] };
    if (method === 'POST' || method === 'PATCH') return { status: 'success', mailbox: { ...(payload || {}) } };
    throw new Error(`unexpected ${method} ${url}`);
  };
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1);
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  for (const src of [COLOR, inline[0]]) {
    const sc = window.document.createElement('script');
    sc.textContent = src;
    window.document.body.appendChild(sc);
  }
  await tick(window, 60);
  return { window, doc: window.document, calls, errors };
}

const lastWrite = (calls) => calls.filter((c) => c.method === 'POST' || c.method === 'PATCH').pop();

const ALIAS_ROW = box(7, {
  address: 'it@firm.test', display_name: 'IT', alias_of: 2, alias_label: 'IT', alias_of_address: 'box2@firm.test',
  has_secret: false, ingest_enabled: false, send_credential_id: 6, send_credential_email: 'it@firm.test',
});

describe('mailbox admin — send-as (alias) mode', () => {
  test('the type toggle swaps the sections; the parent picker lists non-alias boxes only; Save POSTs the alias shape and nothing connection-shaped', async () => {
    const { window, doc, calls, errors } = await boot({ rows: [box(1), box(2), ALIAS_ROW] });
    expect(errors).toEqual([]);
    doc.getElementById('new-btn').click();
    await tick(window);
    expect(doc.getElementById('mb-type-section').hidden).toBe(false);
    expect([doc.getElementById('mb-alias-section').hidden, doc.getElementById('mb-conn-section').hidden]).toEqual([true, false]);
    doc.getElementById('mb-type-alias').checked = true;
    doc.getElementById('mb-type-alias').dispatchEvent(new window.Event('change', { bubbles: true }));
    expect([doc.getElementById('mb-alias-section').hidden, doc.getElementById('mb-conn-section').hidden,
      doc.getElementById('mb-ingest-section').hidden]).toEqual([false, true, true]);
    const opts = [...doc.getElementById('mb-parent').options].map((o) => o.value).filter(Boolean);
    expect(opts).toEqual(['1', '2']);                                    // never the alias row itself

    // no parent picked → an inline error, nothing POSTs
    doc.getElementById('mb-address').value = 'rena@firm.test';
    doc.getElementById('mb-save').click();
    await tick(window);
    expect(doc.getElementById('mb-msg').textContent).toMatch(/Pick the box/);
    expect(lastWrite(calls)).toBeUndefined();

    doc.getElementById('mb-parent').value = '2';
    doc.getElementById('mb-alias-label').value = 'Rena';
    doc.getElementById('mb-cred').value = '6';
    doc.getElementById('mb-save').click();
    await tick(window, 60);
    const w = lastWrite(calls);
    expect(w.method).toBe('POST');
    expect(w.payload).toMatchObject({ address: 'rena@firm.test', alias_of: 2, alias_label: 'Rena', send_credential_id: 6 });
    for (const k of ['imap_host', 'imap_user', 'imap_secret', 'ingest_enabled', 'ingest_folders', 'imap_port']) {
      expect(w.payload).not.toHaveProperty(k);
    }
  });

  test('editing an alias: no type toggle, the parent picker on the current box, the label PATCHes alone; the list row says send-as of the parent', async () => {
    const { window, doc, calls } = await boot({ rows: [box(2), box(3), ALIAS_ROW] });
    expect(doc.querySelector('tr[data-id="7"]').textContent).toMatch(/send-as.*of box2@firm\.test.*label IT/s);
    doc.querySelector('tr[data-id="7"] [data-act="edit"]').click();
    await tick(window, 60);
    expect([doc.getElementById('mb-type-section').hidden, doc.getElementById('mb-alias-section').hidden,
      doc.getElementById('mb-conn-section').hidden, doc.getElementById('mb-parent-fld').hidden]).toEqual([true, false, true, false]);
    expect(doc.getElementById('mb-alias-linkage').textContent).toMatch(/Send-as address of box2@firm\.test/);
    expect(doc.getElementById('mb-parent').value).toBe('2');
    expect(doc.getElementById('mb-alias-label').value).toBe('IT');
    doc.getElementById('mb-alias-label').value = 'IT desk';
    doc.getElementById('mb-save').click();
    await tick(window, 60);
    let w = lastWrite(calls);
    expect(w.payload).toEqual({ alias_label: 'IT desk' });                       // the unchanged parent is not sent
    expect(w).toMatchObject({ url: '/api/mailboxes/7', method: 'PATCH' });
  });

  test('re-pointing an alias from the edit form PATCHes alias_of alone (never cleared)', async () => {
    const { window, doc, calls } = await boot({ rows: [box(2), box(3), ALIAS_ROW] });
    doc.querySelector('tr[data-id="7"] [data-act="edit"]').click();
    await tick(window, 60);
    doc.getElementById('mb-parent').value = '3';
    doc.getElementById('mb-save').click();
    await tick(window, 60);
    expect(lastWrite(calls)).toMatchObject({ url: '/api/mailboxes/7', method: 'PATCH', payload: { alias_of: 3 } });
    expect(Object.keys(lastWrite(calls).payload)).toEqual(['alias_of']);
  });
});
