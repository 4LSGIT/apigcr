// tests/campaignC1.ui.test.js
//
/**
 * YisraMail C1 — public/campaign.html: the class picker (operational default,
 * the honesty line verbatim; marketing swaps in the topic select and the
 * marketing senders, and is off for SMS), the consent preview carries class +
 * topic, the over-cap 409 prompts for the typed count and resends it, and the
 * View tab's paused status, Pause / Resume buttons, class badges and unknown
 * counts. Same JSDOM boot as tests/consentUi.test.js (the page's script, minus
 * the parent poll). Run: npx jest tests/campaignC1.ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
const DOMS = [];
afterAll(() => { for (const d of DOMS) d.window.close(); });

const OPTS = { marketing_senders: [{ email: 'news@news.test', from_name: 'News' }], topics: [{ topic_key: 'newsletter', label: 'Newsletter' }],
  operational_cap: 50, marketing_rate: 60, marketing_enabled: true, can_bulk: true };

function boot(answer, { swal = async () => ({ isConfirmed: false }) } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  const calls = [];
  const fires = [];
  const parent = {
    apiSend: async (url, method, body) => { calls.push({ url, method, body }); return answer(url, method, body); },
    Swal: { mixin: () => ({ fire() {} }), fire: async (o) => { fires.push(o); return swal(o); } },
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
window.__t = { loadComposeOptions, onChannelChange, onClassChange, campaignClass, campaignTopic, renderContacts, runConsentPreview,
  postCampaign, renderCampaignList, pauseCampaignRow, resumeCampaignRow };`);
  return { w, calls, fires, $: (id) => w.document.getElementById(id) };
}
const pick = (w, v) => { const r = w.document.querySelector(`input[name="c-class"][value="${v}"]`); r.checked = true; return r; };
const senders = (b) => [...b.$('c-sender').options].map((o) => o.value);

describe('the class picker', () => {
  test('operational by default, with the honesty line verbatim; marketing swaps the topic + the marketing senders in', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? OPTS : {}));
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    expect(b.w.__t.campaignClass()).toBe('operational');
    expect(b.$('class-honesty').textContent).toContain("this message is about the recipient's case, appointment or account — not promoting services");
    expect(b.$('class-honesty').classList.contains('hidden')).toBe(false);
    expect(b.$('class-marketing').classList.contains('hidden')).toBe(true);
    expect(senders(b)).toEqual(['ops@firm.test']);
    pick(b.w, 'marketing');
    b.w.__t.onClassChange();
    expect(b.w.__t.campaignClass()).toBe('marketing');
    expect(b.$('class-honesty').classList.contains('hidden')).toBe(true);
    expect(b.$('class-marketing').classList.contains('hidden')).toBe(false);
    expect(senders(b)).toEqual(['news@news.test']);
    expect(b.w.__t.campaignTopic()).toBe('newsletter');
  });

  test('SMS: marketing is disabled (D1) and the class falls back to operational', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? OPTS : {}));
    await b.w.__t.loadComposeOptions();
    pick(b.w, 'marketing');
    b.$('f-channel').value = 'sms';
    b.w.__t.onChannelChange();
    expect(b.w.document.querySelector('input[name="c-class"][value="marketing"]').disabled).toBe(true);
    expect(b.w.__t.campaignClass()).toBe('operational');
    expect(senders(b)).toEqual(['2485550000']);
  });

  test('switch off / no capability: the marketing note says so (the server still decides)', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? { ...OPTS, marketing_enabled: false } : {}));
    await b.w.__t.loadComposeOptions();
    pick(b.w, 'marketing');
    b.w.__t.onClassChange();
    expect(b.$('class-marketing-note').textContent).toMatch(/not switched on/);
  });
});

describe('the consent preview follows the class', () => {
  test('operational posts class operational (no topic); marketing posts class + topic', async () => {
    const b = boot((url) => (url === '/api/campaigns/compose-options' ? OPTS : { status: 'success', skipped_optout: 0 }));
    await b.w.__t.loadComposeOptions();
    b.w.__t.onChannelChange();
    b.w.__t.renderContacts({ contacts: [{ contact_id: 1 }, { contact_id: 2 }], total: 2, excluded: 0 });
    await b.w.__t.runConsentPreview();
    expect(b.calls.filter((c) => c.url === '/api/consent/preview').pop().body).toEqual({ channel: 'email', class: 'operational', contact_ids: [1, 2] });
    expect(b.$('consent-skip').textContent).toBe('');
    pick(b.w, 'marketing');
    b.w.__t.onClassChange();
    await b.w.__t.runConsentPreview();
    expect(b.calls.filter((c) => c.url === '/api/consent/preview').pop().body).toEqual({ channel: 'email', class: 'marketing', topic: 'newsletter', contact_ids: [1, 2] });
  });
});

describe('the over-cap prompt', () => {
  const refuse = () => { const e = new Error('over'); e.status = 409; e.body = { code: 'over_cap_confirmation', count: 51, cap: 50, error: 'This campaign has 51 recipients.' }; throw e; };
  test('409 → a typed-count prompt that only accepts the exact count → resent with confirmCount', async () => {
    let n = 0;
    const b = boot((url, m, body) => { if (url !== '/api/campaigns') return {}; n++; if (!body.confirmCount) refuse(); return { campaignId: 9, status: 'sending' }; },
      { swal: async () => ({ isConfirmed: true, value: ' 51 ' }) });
    expect(await b.w.__t.postCampaign({ type: 'email', class: 'operational' })).toEqual({ campaignId: 9, status: 'sending' });
    expect(n).toBe(2);
    expect(b.calls[1].body).toMatchObject({ confirmCount: 51, class: 'operational' });
    const v = b.fires[0].inputValidator;
    expect([v('51'), v(' 51'), v('50'), v('')]).toEqual([undefined, undefined, 'Type 51 exactly', 'Type 51 exactly']);
  });
  test('dismissed → null, nothing resent; other refusals (403 / 422) throw to the error dialog', async () => {
    const b = boot(() => refuse());
    expect(await b.w.__t.postCampaign({ type: 'email' })).toBeNull();
    expect(b.calls).toHaveLength(1);
    const c = boot(() => { const e = new Error('Marketing campaigns are switched off.'); e.status = 422; e.body = { code: 'marketing_disabled' }; throw e; });
    await expect(c.w.__t.postCampaign({ type: 'email' })).rejects.toThrow('switched off');
  });
});

describe('the View tab', () => {
  test('paused: Resume + Cancel; sending / scheduled: Pause + Cancel; class + over-cap badges; unknown counted', () => {
    const b = boot(() => ({}));
    b.w.__t.renderCampaignList([
      { campaign_id: 1, type: 'email', class: 'operational', status: 'paused', contact_count: 3, sent_count: 1, sending_count: 1 },
      { campaign_id: 2, type: 'email', class: 'marketing', status: 'sending', contact_count: 3 },
      { campaign_id: 3, type: 'email', class: 'operational', bulk_confirmed_count: 60, status: 'partial_fail', contact_count: 60, sent_count: 58, unknown_count: 2 },
    ]);
    const rows = [...b.$('view-tbody').querySelectorAll('tr')];
    const buttons = (r) => [...r.querySelectorAll('button')].map((x) => x.textContent);
    expect(buttons(rows[0])).toEqual(['Stats', 'Resume', 'Cancel', 'Dup']);
    expect(rows[0].textContent).toContain('(1 in flight)');
    expect(rows[0].querySelector('.badge-paused')).not.toBeNull();
    expect(buttons(rows[1])).toEqual(['Stats', 'Pause', 'Cancel', 'Dup']);
    expect(rows[1].textContent).toContain('marketing');
    expect(rows[2].textContent).toContain('over cap');
    expect(rows[2].textContent).toContain('2 unknown');
    expect(b.$('v-status').querySelector('option[value="paused"]')).not.toBeNull();
  });
  test('counts arrive from mysql2 as strings (SUM): progress adds them as numbers', () => {
    const b = boot(() => ({}));
    b.w.__t.renderCampaignList([{ campaign_id: 5, type: 'email', class: 'operational', status: 'sending', contact_count: 4,
      sent_count: '1', failed_count: '0', skipped_count: '1', unknown_count: null, sending_count: '1' }]);
    expect(b.$('view-tbody').textContent).toContain('2/4');
    b.w.__t.renderCampaignList([{ campaign_id: 6, type: 'email', status: 'partial_fail', contact_count: 3, sent_count: '2', failed_count: '1', skipped_count: '0' }]);
    expect(b.$('view-tbody').querySelector('td:nth-child(6)').textContent.replace(/\s+/g, ' ').trim()).toBe('2 / 1');
  });

  test('Pause / Resume send the PATCH; no document or button member shadows the handler names', async () => {
    const b = boot(() => ({}));
    b.w.__t.loadCampaigns = () => {};
    await b.w.__t.pauseCampaignRow(4);
    await b.w.__t.resumeCampaignRow(4);
    expect(b.calls.filter((c) => c.method === 'PATCH').map((c) => [c.url, c.body])).toEqual([['/api/campaigns/4', { status: 'paused' }], ['/api/campaigns/4', { status: 'sending' }]]);
    const btn = b.w.document.createElement('button');
    for (const n of ['pauseCampaignRow', 'resumeCampaignRow', 'onClassChange', 'onTopicChange']) {
      expect(n in b.w.document).toBe(false);
      expect(n in btn).toBe(false);
    }
  });
});
