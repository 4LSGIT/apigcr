// tests/campaignPreviewEscape.test.js
//
/**
 * Campaign bodies: substituted values are data, never markup.
 *
 * The hole this pins (found by the YisraMail design review, 2026-10-29):
 * campaign.html's preview concatenated the RESOLVED email body into the
 * shell's Swal `html`, and resolverService had no HTML escape mode — so a
 * contact field carrying markup (web-form intake, imports) would have run as
 * script in a pane that can reach parent.apiSend, and would have gone out
 * as live markup in the email itself.
 *
 * Three walls, each pinned here:
 *   1. resolverService `escape: 'html'` — every substituted value escaped
 *      (& < > " '), applied once (no double escape through nested defaults);
 *      the authored template around it untouched.
 *   2. campaignService — previewCampaign and executeSend escape EMAIL bodies
 *      (never subjects, never SMS bodies).
 *   3. campaign.html — the email preview renders in a sandbox="" iframe fed
 *      through the srcdoc PROPERTY; the resolved body never enters the
 *      dialog's markup string. SMS previews render as escaped text.
 *   + emailService's derived text part decodes the &#39; the escape produces.
 *
 * Run:  npx jest tests/campaignPreviewEscape.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

jest.mock('../services/emailService', () => {
  const actual = jest.requireActual('../services/emailService');
  return { ...actual, sendEmail: jest.fn(async () => ({ messageId: 'm-1', provider: 'smtp' })) };
});
jest.mock('../services/phoneService', () => {
  const actual = jest.requireActual('../services/phoneService');
  return { ...actual, sendSms: jest.fn(async () => ({ id: 'sms-1' })), sendMms: jest.fn(async () => ({ id: 'mms-1' })) };
});

const { resolve } = require('../services/resolverService');
const campaignService = require('../services/campaignService');
const emailService = require('../services/emailService');
const phoneService = require('../services/phoneService');

const EVIL = '<img src=x onerror="window.__pwned=1">';
const EVIL_ESCAPED = '&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;';

// ───────────────────────────────────────────────────────────────────────────
// 1. resolverService escape: 'html'
// ───────────────────────────────────────────────────────────────────────────

describe("resolverService — escape: 'html'", () => {
  const td = (v) => ({ trigger_data: v });

  test('escapes all five significant characters in a substituted value', async () => {
    const r = await resolve({ db: null, text: '<p>{{trigger_data.v}}</p>', refs: td({ v: `a&b<c>d"e'f` }), escape: 'html' });
    expect(r.status).toBe('success');
    expect(r.text).toBe('<p>a&amp;b&lt;c&gt;d&quot;e&#39;f</p>');
  });

  test('a markup-carrying value arrives as text; the authored template is untouched', async () => {
    const r = await resolve({ db: null, text: '<b>Hi</b> {{trigger_data.v}}', refs: td({ v: EVIL }), escape: 'html' });
    expect(r.text).toBe(`<b>Hi</b> ${EVIL_ESCAPED}`);
    expect(r.text).not.toContain('<img');
  });

  test('nested default resolves once and is escaped once (no &amp;amp;)', async () => {
    const r = await resolve({
      db: null,
      text: '{{trigger_data.missing|default:{{trigger_data.v}}}}',
      refs: td({ v: 'Tom & Jerry' }),
      escape: 'html',
    });
    expect(r.text).toBe('Tom &amp; Jerry');
  });

  test('no escape option → verbatim (every existing caller unchanged)', async () => {
    const r = await resolve({ db: null, text: '{{trigger_data.v}}', refs: td({ v: EVIL }) });
    expect(r.text).toBe(EVIL);
  });

  test("escape: 'json' is unchanged", async () => {
    const r = await resolve({ db: null, text: '"{{trigger_data.v}}"', refs: td({ v: 'a"b' }), escape: 'json' });
    expect(r.text).toBe('"a\\"b"');
  });

  test('an unknown escape mode still throws', async () => {
    await expect(resolve({ db: null, text: 'x', refs: {}, escape: 'xml' })).rejects.toThrow(/unsupported escape mode/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. campaignService — preview + executeSend
// ───────────────────────────────────────────────────────────────────────────

/**
 * A scripted db: answers the resolver's contacts SELECT with a row whose
 * contact_fname carries markup, the campaign / contact loads, the opt-out
 * lookup (nobody opted out), recordResult, and checkCompletion (still in
 * progress → returns before finalizing).
 */
function fakeDb({ campaign } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM `contacts`/.test(sql)) return [[{ contacts__contact_fname: EVIL }]];
      if (/FROM campaigns WHERE campaign_id/.test(sql)) return [[campaign]];
      if (/FROM contacts WHERE contact_id/.test(sql)) {
        return [[{ contact_id: 7, contact_name: 'X', contact_phone: '2485550100', contact_email: 'x@example.com' }]];
      }
      if (/sms_optout = 1|email_optout = 1/.test(sql)) return [[]];
      if (/AS total/.test(sql)) return [[{ total: 2, done: 1 }]];
      if (/^\s*INSERT/i.test(sql)) return [{ affectedRows: 1, insertId: 1 }];
      return [[]];
    },
  };
}

describe('campaignService.previewCampaign', () => {
  test('email (default type): substituted values are HTML-escaped; subject is not', async () => {
    const db = fakeDb();
    const out = await campaignService.previewCampaign(db, {
      body: '<p>Hi {{contacts.contact_fname}}</p>',
      subject: 'For {{contacts.contact_fname}}',
      contactId: 7,
    });
    expect(out.body).toBe(`<p>Hi ${EVIL_ESCAPED}</p>`);
    expect(out.body).not.toContain('<img');
    expect(out.subject).toBe(`For ${EVIL}`);
  });

  test("type 'sms': the body is plain text, substituted verbatim", async () => {
    const db = fakeDb();
    const out = await campaignService.previewCampaign(db, {
      body: 'Hi {{contacts.contact_fname}}', contactId: 7, type: 'sms',
    });
    expect(out.body).toBe(`Hi ${EVIL}`);
  });

  test('an unrecognized type fails closed to escaping', async () => {
    const db = fakeDb();
    const out = await campaignService.previewCampaign(db, {
      body: '{{contacts.contact_fname}}', contactId: 7, type: 'fax',
    });
    expect(out.body).toBe(EVIL_ESCAPED);
  });
});

describe('campaignService.executeSend', () => {
  beforeEach(() => { emailService.sendEmail.mockClear(); phoneService.sendSms.mockClear(); });

  test('email: the html sent carries escaped values; the subject header is unescaped', async () => {
    const db = fakeDb({ campaign: {
      campaign_id: 1, type: 'email', sender: 'office@4lsg.com',
      subject: 'For {{contacts.contact_fname}}',
      body: '<p>Hi {{contacts.contact_fname}}</p>',
      attachment_url: null, include_signature: 0, status: 'sending',
    } });
    const out = await campaignService.executeSend(db, 1, 7);
    expect(out.sent).toBe(true);
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    const opts = emailService.sendEmail.mock.calls[0][1];
    expect(opts.html).toBe(`<p>Hi ${EVIL_ESCAPED}</p>`);
    expect(opts.html).not.toContain('<img');
    expect(opts.subject).toBe(`For ${EVIL}`);
  });

  test('sms: the text sent is verbatim (no entities in a text message)', async () => {
    const db = fakeDb({ campaign: {
      campaign_id: 2, type: 'sms', sender: '2484179800', subject: null,
      body: 'Hi {{contacts.contact_fname}}',
      attachment_url: null, include_signature: 0, status: 'sending',
    } });
    const out = await campaignService.executeSend(db, 2, 7);
    expect(out.sent).toBe(true);
    expect(phoneService.sendSms).toHaveBeenCalledTimes(1);
    expect(phoneService.sendSms.mock.calls[0][3]).toBe(`Hi ${EVIL}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2b. emailService text part decodes the &#39; the escape produces
// ───────────────────────────────────────────────────────────────────────────

describe('emailService.normalizeBodies — derived text part', () => {
  test('&#39; / &#x27; / &apos; decode to an apostrophe', () => {
    const { text } = emailService.normalizeBodies(undefined, '<p>O&#39;Brien, O&#x27;Neil, O&apos;Hara</p>');
    expect(text).toBe("O'Brien, O'Neil, O'Hara");
  });

  test('an escaped value reads naturally in the text part', () => {
    const { text } = emailService.normalizeBodies(undefined, `<p>Hi ${EVIL_ESCAPED} &amp; co</p>`);
    expect(text).toBe(`Hi ${EVIL} & co`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. campaign.html — the preview dialog
// ───────────────────────────────────────────────────────────────────────────

const ROOT    = path.join(__dirname, '..');
const HTML    = fs.readFileSync(path.join(ROOT, 'public/campaign.html'), 'utf8');

const DOMS = [];
afterEach(() => DOMS.splice(0).forEach((d) => { try { d.window.close(); } catch (_) { /* noop */ } }));

/**
 * Boots campaign.html's inline script against a stub shell. Quill is stubbed
 * (the blot subclass runs at top level) and the boot IIFE is stripped so
 * init() never auto-fires. The shell's Swal records every fire() option set.
 */
function boot(previewResponse) {
  const shellDom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://app.4lsg.com/index.html' });
  DOMS.push(shellDom);
  const shell = shellDom.window;
  const fired = [];
  shell.Swal = { fire: (o) => { fired.push(o); return Promise.resolve({}); }, mixin: () => ({ fire() {} }) };
  const sent = [];
  shell.apiSend = async (url, method, body) => { sent.push({ url, method, body }); return previewResponse; };

  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  Object.defineProperty(w, 'parent', { value: shell, configurable: true });
  w.Quill = function () { return { on() {}, root: { innerHTML: '' } }; };
  w.Quill.import = () => class { static create() { return {}; } static value() { return {}; } };
  w.Quill.register = () => {};

  const m = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  const body = m[1].replace(/\(function waitForParent\(\)[\s\S]*$/, '');
  w.eval(body + '\n;window.__t = { previewCampaign, setSelected: (a) => { selectedContacts = a; } };');
  w.__t.setSelected([{ contact_id: 7, contact_name: 'Sample <b>Name</b>' }]);
  return { w, shell, fired, sent };
}

/** Render a fired dialog's html into a scratch document and run its didOpen. */
function openDialog(opts) {
  const d = new JSDOM(`<!DOCTYPE html><html><body><div id="popup">${opts.html}</div></body></html>`);
  DOMS.push(d);
  const popup = d.window.document.getElementById('popup');
  if (typeof opts.didOpen === 'function') opts.didOpen(popup);
  return popup;
}

describe('campaign.html — preview dialog', () => {
  const EMAIL_BODY = `<p>Hi ${EVIL}</p>`; // even if the server ever failed to escape

  test('email: the body renders only inside a sandbox="" iframe via srcdoc', async () => {
    const { w, fired, sent } = boot({ body: EMAIL_BODY, subject: `S ${EVIL}`, unresolved: [] });
    w.document.getElementById('f-channel').value = 'email';
    w.document.getElementById('c-subject').value = 'S';
    w.document.getElementById('html-editor').value = '<p>Hi {{contacts.contact_fname}}</p>';

    await w.__t.previewCampaign();

    expect(sent).toHaveLength(1);
    expect(sent[0].body.type).toBe('email');
    expect(fired).toHaveLength(1);
    const opts = fired[0];
    expect(opts.html).not.toContain(EVIL);              // never concatenated into the dialog
    expect(opts.html).not.toContain('<img');
    const popup = openDialog(opts);
    const frame = popup.querySelector('iframe[data-campaign-preview]');
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('');      // every restriction on: no scripts, opaque origin
    expect(frame.srcdoc).toBe(EMAIL_BODY);
    expect(popup.querySelector('img')).toBeNull();        // nothing rendered in the dialog itself
    expect(popup.textContent).toContain(`S ${EVIL}`);     // subject shown as text
    expect(popup.textContent).toContain('Sample <b>Name</b>');
  });

  test('sms: the body renders as escaped text, no iframe', async () => {
    const { w, fired, sent } = boot({ body: `Hi ${EVIL}`, subject: null, unresolved: [] });
    w.document.getElementById('f-channel').value = 'sms';
    w.document.getElementById('c-sms-body').value = 'Hi {{contacts.contact_fname}}';

    await w.__t.previewCampaign();

    expect(sent[0].body.type).toBe('sms');
    const opts = fired[0];
    expect(opts.html).not.toContain('<img');
    const popup = openDialog(opts);
    expect(popup.querySelector('iframe')).toBeNull();
    expect(popup.querySelector('img')).toBeNull();
    expect(popup.textContent).toContain(`Hi ${EVIL}`);
  });
});
