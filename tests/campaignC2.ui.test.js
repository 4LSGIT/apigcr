// tests/campaignC2.ui.test.js
//
/**
 * YisraMail C2 — public/campaign.html: the "Send test to me" button exists only for the marketing
 * class with campaigns.bulk, posts the compose form (first selected contact, topic, sender,
 * subject, body) to POST /api/campaigns/test-send and toasts the address it went to; a HELD
 * marketing transport stays listed with "— HELD". Same JSDOM boot as tests/campaignC1.ui.test.js.
 * Run: npx jest tests/campaignC2.ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
const DOMS = [];
afterAll(() => { for (const d of DOMS) d.window.close(); });

const OPTS = { marketing_senders: [{ id: 17, email: 'news@news.test', from_name: 'News', held: false, held_reason: null }],
  topics: [{ topic_key: 'newsletter', label: 'Newsletter' }], operational_cap: 50, marketing_rate: 60, marketing_enabled: false, can_bulk: true };

function boot(answer) {
  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  const calls = [];
  const toasts = [];
  const parent = {
    apiSend: async (url, method, body) => { calls.push({ url, method, body }); return answer(url, method, body); },
    Swal: { mixin: () => ({ fire(o) { toasts.push(o); } }), fire: async () => ({ isConfirmed: false }) },
    firmData: { emailFrom: [{ email: 'ops@firm.test', from_name: 'Ops' }], phoneLines: [{ phone_number: '2485550000', mms_capable: 0 }] },
  };
  Object.defineProperty(w, 'parent', { value: parent, configurable: true });
  w.Quill = function () { return { on() {}, root: { innerHTML: '' } }; };
  w.Quill.import = () => class { static create() { return {}; } static value() { return {}; } };
  w.Quill.register = () => {};
  const m = HTML.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  const body = m[1].replace(/\(function waitForParent\(\)[\s\S]*$/, '');
  w.eval(`${body}
;phoneLines = P.firmData.phoneLines; emailAddresses = P.firmData.emailFrom;
window.__t = { loadComposeOptions, onChannelChange, onClassChange, sendMarketingTest, setSelected: (a) => { selectedContacts = a; } };`);
  return { w, calls, toasts, $: (id) => w.document.getElementById(id) };
}
const pick = (w, v) => { const r = w.document.querySelector(`input[name="c-class"][value="${v}"]`); r.checked = true; return r; };

describe('Send test to me', () => {
  test('hidden for operational; shown for marketing with campaigns.bulk (the switch may be off); hidden without the capability', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? OPTS : {}));
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    expect(b.$('c-test-send').classList.contains('hidden')).toBe(true);
    pick(b.w, 'marketing'); b.w.__t.onClassChange();
    expect(b.$('c-test-send').classList.contains('hidden')).toBe(false);

    const c = boot((url) => (url === '/api/campaigns/compose-options' ? { ...OPTS, can_bulk: false } : {}));
    await c.w.__t.loadComposeOptions();
    c.w.__t.onChannelChange();
    pick(c.w, 'marketing'); c.w.__t.onClassChange();
    expect(c.$('c-test-send').classList.contains('hidden')).toBe(true);
  });

  test('posts the compose form for the FIRST selected contact and toasts where it went', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? OPTS : url === '/api/campaigns/test-send' ? { sent: true, to: 'fred@firm.test' } : {}));
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    pick(b.w, 'marketing'); b.w.__t.onClassChange();
    b.w.__t.setSelected([{ contact_id: 42, contact_name: 'Sam' }, { contact_id: 43 }]);
    b.$('c-subject').value = 'News for {{contacts.contact_fname}}';
    b.$('html-editor').value = '<p>Hi</p>';
    await b.w.__t.sendMarketingTest();
    const call = b.calls.find((x) => x.url === '/api/campaigns/test-send');
    expect(call).toEqual({ url: '/api/campaigns/test-send', method: 'POST',
      body: { sender: 'news@news.test', subject: 'News for {{contacts.contact_fname}}', body: '<p>Hi</p>', topic_key: 'newsletter', contactId: 42 } });
    expect(b.toasts.pop()).toMatchObject({ icon: 'success', title: 'Test sent to fred@firm.test' });
  });

  test('nothing is posted without a selected contact; an error toasts its message', async () => {
    const b = boot((url) => { if (url === '/api/campaigns/compose-options') return OPTS; if (url === '/api/campaigns/test-send') throw new Error('Transport news@news.test is held: x'); return {}; });
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    pick(b.w, 'marketing'); b.w.__t.onClassChange();
    await b.w.__t.sendMarketingTest();
    expect(b.calls.some((x) => x.url === '/api/campaigns/test-send')).toBe(false);
    b.w.__t.setSelected([{ contact_id: 42 }]);
    b.$('c-subject').value = 'S';
    b.$('html-editor').value = '<p>Hi</p>';
    await b.w.__t.sendMarketingTest();
    expect(b.toasts.pop()).toMatchObject({ icon: 'error', title: 'Transport news@news.test is held: x' });
  });

  test('a held marketing transport is listed with "— HELD"', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? { ...OPTS, marketing_senders: [{ ...OPTS.marketing_senders[0], held: true, held_reason: 'complaints' }] } : {}));
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    pick(b.w, 'marketing'); b.w.__t.onClassChange();
    expect([...b.$('c-sender').options].map((o) => o.textContent)).toEqual(['News (news@news.test) — HELD']);
  });
});
