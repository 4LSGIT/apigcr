// tests/logCommDate.pane.test.js
//
/**
 * log-comm-date — public/communicate.html, the compose pane behind the
 * Communications tab's "Send / log…".
 *
 *   - Log Call: the Direction chooser swaps the From/To rows (incoming = the
 *     caller's number is the From), and the POST carries direction + typed
 *     from/to that match it.
 *   - Log Call's When: untouched sends no `date` (the server stamps the row);
 *     a changed time goes as `date`; a future one never posts; a successful
 *     log re-defaults it.
 *   - Log Without Sending (text + email) asks when: an unchanged answer sends
 *     no `date`, a changed one does, cancel posts nothing. Send never asks.
 *
 * The page's real script runs in JSDOM; only its CDN globals (SweetAlert2,
 * Quill) are stubbed — they never load here.
 *
 * Run:  npx jest tests/logCommDate.pane.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'communicate.html'), 'utf8');
// The page loads it with <script src>; JSDOM here fetches no external script.
const OPTOUT = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'optoutAck.js'), 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const LINE = '2485592400';
const PARTY = '2482598221';

function boot({ whenAnswer = null } = {}) {
  const posts = [];
  const toasts = [];
  const prompts = [];
  const apiSend = jest.fn(async (url, method, body) => {
    if (method === 'POST') posts.push({ url, body });
    return { status: 'success', log_id: 1 };
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example.test/communicate.html',
    beforeParse(window) {
      window.eval(OPTOUT);
      window.apiSend = apiSend;
      window.firmData = {
        phoneLines: [{ phone_number: LINE, display_name: 'Main' }],
        emailFrom: [{ email: 'staff@firm.test' }],
        currentUser: { default_phone: LINE, default_email: 'staff@firm.test' },
        firmTimezone: 'America/Detroit',
      };
      window.entityData = { contact: { contact_id: 2111, contact_phone: PARTY, contact_email: 'c@x.test' } };
      window.Swal = {
        mixin: () => ({ fire: (o) => { toasts.push(o); return Promise.resolve({}); } }),
        fire: async (o) => {
          if (o && o.input === 'datetime-local') {
            prompts.push(o);
            // whenAnswer: 'same' = confirm the offered value; a string = the
            // user picked that; null = cancel.
            if (whenAnswer === null) return { isConfirmed: false };
            return { isConfirmed: true, value: whenAnswer === 'same' ? o.inputValue : whenAnswer };
          }
          return { isConfirmed: true };
        },
        close: () => {},
        showValidationMessage: () => {},
      };
      class BaseImage {}
      const editor = { root: { innerHTML: '<p>Body</p>', addEventListener() {} }, getText: () => 'Body', setContents() {} };
      window.Quill = Object.assign(function Quill() { return editor; }, {
        import: () => BaseImage, register: () => {},
      });
    },
  });
  return { dom, d: dom.window.document, w: dom.window, posts, toasts, prompts };
}

const logPosts = (posts) => posts.filter((p) => p.url === '/api/log');

describe('Log Call', () => {
  test('outgoing (default): our line → their number, no date when When is untouched', async () => {
    const { d, w, posts, dom } = boot();
    await settle();
    w.showTab('call');
    d.getElementById('call-note').value = 'Discussed the suit';
    await w.send('call');
    const [p] = logPosts(posts);
    expect(p.body).toMatchObject({ type: 'call', direction: 'outgoing', from: LINE, to: PARTY });
    expect(JSON.parse(p.body.data)).toEqual({ from: LINE, to: PARTY, note: 'Discussed the suit' });
    expect('date' in p.body).toBe(false);
    dom.window.close();
  });

  test('incoming swaps the rows and the parties', async () => {
    const { d, w, posts, dom } = boot();
    await settle();
    const sel = d.getElementById('call-direction');
    sel.value = 'incoming';
    sel.dispatchEvent(new w.Event('change'));
    const rows = [...d.getElementById('call-parties').children].map((r) => r.id);
    expect(rows).toEqual(['call-party-row', 'call-line-row']);
    expect(d.getElementById('call-party-label').textContent).toBe('From:');
    expect(d.getElementById('call-line-label').textContent).toBe('To:');

    d.getElementById('call-note').value = 'He called about being sued';
    await w.send('call');
    const [p] = logPosts(posts);
    expect(p.body).toMatchObject({ direction: 'incoming', from: PARTY, to: LINE });
    expect(JSON.parse(p.body.data)).toMatchObject({ from: PARTY, to: LINE });

    // and back
    sel.value = 'outgoing';
    sel.dispatchEvent(new w.Event('change'));
    expect([...d.getElementById('call-parties').children].map((r) => r.id)).toEqual(['call-line-row', 'call-party-row']);
    expect(d.getElementById('call-line-label').textContent).toBe('From:');
    dom.window.close();
  });

  test('a changed When goes as date, then the field re-defaults (next log sends none)', async () => {
    const { d, w, posts, dom } = boot();
    await settle();
    const when = d.getElementById('call-when');
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    when.value = '2026-10-18T14:30';
    when.dispatchEvent(new w.Event('input'));
    d.getElementById('call-note').value = 'first';
    await w.send('call');
    expect(logPosts(posts)[0].body.date).toBe('2026-10-18T14:30');
    expect(when.value).not.toBe('2026-10-18T14:30');
    expect(when.dataset.touched).toBeUndefined();

    d.getElementById('call-note').value = 'second';
    await w.send('call');
    expect('date' in logPosts(posts)[1].body).toBe(false);
    dom.window.close();
  });

  test('a future When never posts', async () => {
    const { d, w, posts, toasts, dom } = boot();
    await settle();
    const when = d.getElementById('call-when');
    when.value = '2099-01-01T00:00';
    when.dispatchEvent(new w.Event('input'));
    d.getElementById('call-note').value = 'x';
    await w.send('call');
    expect(logPosts(posts)).toHaveLength(0);
    expect(toasts.some((t) => /future/.test(t.title))).toBe(true);
    dom.window.close();
  });

  test('re-opening the tab keeps a time the user set', async () => {
    const { d, w, dom } = boot();
    await settle();
    const when = d.getElementById('call-when');
    when.value = '2026-10-18T14:30';
    when.dispatchEvent(new w.Event('input'));
    w.showTab('sms');
    w.showTab('call');
    expect(when.value).toBe('2026-10-18T14:30');
    dom.window.close();
  });
});

describe('Log Without Sending asks when', () => {
  const fillSms = (d) => { d.getElementById('sms-body').value = 'Hi'; };
  const fillEmail = (d) => { d.getElementById('email-subject').value = 'Re: suit'; };

  test.each([
    ['logSms', fillSms, 'sms'],
    ['logEmail', fillEmail, 'email'],
  ])('%s: a changed time goes as date', async (action, fill, type) => {
    const { d, w, posts, prompts, dom } = boot({ whenAnswer: '2026-10-17T09:05' });
    await settle();
    fill(d);
    await w.send(action);
    expect(prompts).toHaveLength(1);
    const [p] = logPosts(posts);
    expect(p.body).toMatchObject({ type, date: '2026-10-17T09:05' });
    dom.window.close();
  });

  test.each([
    ['logSms', fillSms],
    ['logEmail', fillEmail],
  ])('%s: the offered time unchanged sends no date', async (action, fill) => {
    const { d, w, posts, dom } = boot({ whenAnswer: 'same' });
    await settle();
    fill(d);
    await w.send(action);
    const [p] = logPosts(posts);
    expect('date' in p.body).toBe(false);
    dom.window.close();
  });

  test.each([
    ['logSms', fillSms],
    ['logEmail', fillEmail],
  ])('%s: cancel posts nothing', async (action, fill) => {
    const { d, w, posts, dom } = boot({ whenAnswer: null });
    await settle();
    fill(d);
    await w.send(action);
    expect(posts).toHaveLength(0);
    dom.window.close();
  });

  test('a real email Send never asks and sends no date', async () => {
    const { d, w, posts, prompts, dom } = boot({ whenAnswer: '2026-10-17T09:05' });
    await settle();
    fillEmail(d);
    await w.send('email');
    expect(prompts).toHaveLength(0);
    const [p] = logPosts(posts);
    expect('date' in p.body).toBe(false);
    dom.window.close();
  });
});
