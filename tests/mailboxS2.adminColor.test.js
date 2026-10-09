/**
 * Mailboxes admin pane (public/mailboxAdmin.html) — the S2 colour controls,
 * booted in jsdom against a mocked shell apiSend (the pane's only transport).
 *
 * What this pins (each mutation-checked — break it, watch a test fail):
 *   - a NEW mailbox starts on a random palette colour no other box uses, and
 *     Save sends it (assigned when the box is added); Random re-picks among
 *     the unused ones; a custom pick is sent as picked.
 *   - editing a box that has no colour and leaving the picker alone sends no
 *     `color` (a no-op edit stays a no-op); touching it sends the pick.
 *   - SU and the box's managers change it in place from the list swatch
 *     (PATCH {color}); a refused save puts the swatch back.
 *   - a reader sees the hub's dot (per-theme legible values), not a control.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const MC = require('../public/js/mailboxColor');

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
  access: SU_ACCESS, ...over,
});

async function boot({ rows, su = true, handler = () => ({}) }) {
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
    if (url === '/api/mailboxes' && method === 'GET') return { mailboxes: rows, viewer: { su } };
    if (url === '/api/users') return { users: [] };
    if (url === '/api/email-credentials') return { email_credentials: [] };
    if (method === 'POST' || method === 'PATCH') return { status: 'success', mailbox: { ...(payload || {}) } };
    throw new Error(`unexpected ${method} ${url}`);
  };
  const noComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const bodyHtml = (noComments.match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
  window.document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, '');
  const inline = [...noComments.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(inline.length).toBe(1); // a second inline block means this harness is stale
  expect(noComments).toContain('<script src="/js/mailboxColor.js"></script>');
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
function fillNew(doc) {
  doc.getElementById('mb-address').value = 'new@firm.test';
  doc.getElementById('mb-host').value = 'imap.firm.test';
  doc.getElementById('mb-user').value = 'new';
}

describe('mailbox admin — colour', () => {
  test('a new box starts on an UNUSED palette colour and Save sends it; Random re-picks among the unused', async () => {
    const used = MC.PALETTE.slice(0, 8);
    const rows = used.map((c, i) => box(i + 1, { color: c }));
    const { window, doc, calls, errors } = await boot({ rows });
    expect(errors).toEqual([]);
    const free = MC.PALETTE.slice(8);
    doc.getElementById('new-btn').click();
    await tick(window);
    const picker = doc.getElementById('mb-color');
    expect(free).toContain(picker.value);
    expect(doc.getElementById('mb-color-prev').textContent).toBe('as drawn in the hub');
    for (let i = 0; i < 6; i++) {
      doc.getElementById('mb-color-random').click();
      expect(free).toContain(picker.value);
    }
    const chosen = picker.value;
    fillNew(doc);
    doc.getElementById('mb-save').click();
    await tick(window);
    const w = lastWrite(calls);
    expect([w.method, w.url, w.payload.color]).toEqual(['POST', '/api/mailboxes', chosen]);
  });

  test('a custom pick is sent as picked; a pale one says it is drawn a shade deeper', async () => {
    const { window, doc, calls } = await boot({ rows: [] });
    doc.getElementById('new-btn').click();
    await tick(window);
    const picker = doc.getElementById('mb-color');
    picker.value = '#fff3bf';
    picker.dispatchEvent(new window.Event('input'));
    expect(doc.getElementById('mb-color-prev').textContent).toMatch(/adjusted on this theme/);
    const dot = doc.querySelector('#mb-color-prev .mdot');
    expect([dot.style.getPropertyValue('--mbc-l'), dot.style.getPropertyValue('--mbc-d')]).toEqual([MC.legible('#fff3bf', 'light'), '#fff3bf']);
    fillNew(doc);
    doc.getElementById('mb-save').click();
    await tick(window);
    expect(lastWrite(calls).payload.color).toBe('#fff3bf');
  });

  test('edit: a colourless box left alone sends no color; touching the picker sends it', async () => {
    const { window, doc, calls } = await boot({ rows: [box(1), box(2, { color: '#2f6fd1' })] });
    const editBtn = (id) => doc.querySelector(`tr[data-id="${id}"] [data-act="edit"]`);
    editBtn(1).click();
    await tick(window);
    expect(doc.getElementById('mb-color-prev').textContent).toMatch(/No colour yet/);
    doc.getElementById('mb-display').value = 'Renamed';
    doc.getElementById('mb-save').click();
    await tick(window);
    expect(lastWrite(calls).payload).toEqual({ display_name: 'Renamed' });
    // the same colourless box, picker touched: the pick is sent
    editBtn(1).click();
    await tick(window);
    doc.getElementById('mb-color').value = '#9c36b5';
    doc.getElementById('mb-color').dispatchEvent(new window.Event('input'));
    expect(doc.getElementById('mb-color-prev').textContent).toBe('as drawn in the hub');
    doc.getElementById('mb-save').click();
    await tick(window);
    expect(lastWrite(calls)).toMatchObject({ method: 'PATCH', url: '/api/mailboxes/1', payload: { color: '#9c36b5' } });

    editBtn(2).click();
    await tick(window);
    expect(doc.getElementById('mb-color').value).toBe('#2f6fd1');
    const writes = calls.filter((c) => c.method === 'PATCH').length;
    doc.getElementById('mb-save').click(); // untouched → no write at all
    await tick(window);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(writes);
    editBtn(2).click();
    await tick(window);
    const picker = doc.getElementById('mb-color');
    picker.value = '#c2255c';
    picker.dispatchEvent(new window.Event('input'));
    doc.getElementById('mb-save').click();
    await tick(window);
    expect(lastWrite(calls)).toMatchObject({ method: 'PATCH', url: '/api/mailboxes/2', payload: { color: '#c2255c' } });
  });

  test('managers change it in place from the list swatch; a refused save puts it back', async () => {
    let refuse = false;
    const { window, doc, calls } = await boot({
      rows: [box(1, { color: '#2f6fd1', access: { can_read: true, can_send: false, can_manage: true, su: false } })],
      su: false,
      handler: (url, method, payload) => {
        if (method === 'PATCH' && refuse) throw new Error('nope');
        if (method === 'PATCH') return { status: 'success', mailbox: { id: 1, color: payload.color } };
        return null;
      },
    });
    const sw = doc.querySelector('tr[data-id="1"] input.swatch[type="color"]');
    expect(sw.value).toBe('#2f6fd1');
    sw.value = '#0b7f86';
    sw.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window);
    expect(lastWrite(calls)).toEqual({ url: '/api/mailboxes/1', method: 'PATCH', payload: { color: '#0b7f86' } });
    refuse = true;
    sw.value = '#000000';
    sw.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick(window);
    expect(sw.value).toBe('#0b7f86');
    expect(doc.getElementById('list-error').textContent).toMatch(/Couldn't save the colour: nope/);
  });

  test('a reader sees the hub\'s dot (per-theme values), not a control', async () => {
    const { doc } = await boot({
      rows: [box(1, { color: '#fff3bf', access: { can_read: true, can_send: false, can_manage: false, su: false } })],
      su: false,
    });
    expect(doc.querySelector('tr[data-id="1"] input[type="color"]')).toBeNull();
    const dot = doc.querySelector('tr[data-id="1"] .mdot');
    expect([dot.classList.contains('mbc'), dot.style.getPropertyValue('--mbc-l'), dot.style.getPropertyValue('--mbc-d')])
      .toEqual([true, MC.legible('#fff3bf', 'light'), '#fff3bf']);
  });
});
