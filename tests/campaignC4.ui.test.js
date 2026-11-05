// tests/campaignC4.ui.test.js
//
/**
 * YisraMail C4 — public/campaign.html: the saved-segments picker (load, apply →
 * filter bar + search, save PUT-vs-POST, archive) and the Stats dialog's
 * delivery/transport lines. Same JSDOM boot as tests/campaignC1.ui.test.js.
 * Run: npx jest tests/campaignC4.ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'campaign.html'), 'utf8');
const DOMS = [];
afterAll(() => { for (const d of DOMS) d.window.close(); });

const SEGMENTS = [
  { id: 3, name: 'Everyone', filter: { channel: 'email' }, created_by: 6, archived: false },
  { id: 5, name: 'Ch7 VIPs', filter: { channel: 'email', tags: ['vip'], case_type: 'Bankruptcy', case_subtype: 'Chapter 7', case_stage: ['Open'], case_open_after: '2026-01-01' }, created_by: 6, archived: false },
];

function boot(answer, { swalFire } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://app.4lsg.com/campaign.html', runScripts: 'outside-only' });
  DOMS.push(dom);
  const w = dom.window;
  const calls = [];
  const toasts = [];
  const dialogs = [];
  const parent = {
    apiSend: async (url, method, body) => { calls.push({ url, method: method || 'GET', body }); return answer(url, method || 'GET', body); },
    Swal: {
      mixin: () => ({ fire(o) { toasts.push(o); } }),
      fire: async (o) => { dialogs.push(o); return swalFire ? swalFire(o) : { isConfirmed: false }; },
    },
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
window.__t = { ycSegLoad, ycSegApply, ycSegSave, ycSegArchive, ycSegCurrentFilter, viewStats, clearFilters };`);
  return { w, calls, toasts, dialogs, $: (id) => w.document.getElementById(id) };
}

/** A case-type option the way the shell's populateCaseTypeFilter mints them. */
function addTypeOption(b, type, subtype) {
  const o = b.w.document.createElement('option');
  o.textContent = subtype ? `${type} — ${subtype}` : `${type} (all)`;
  o.dataset.dyn = '1';
  o.dataset.type = type;
  if (subtype) o.dataset.subtype = subtype;
  b.$('f-case-type').appendChild(o);
  return o;
}
const segAnswer = (extra = {}) => (url, method, body) => {
  if (url === '/api/campaigns/segments' && method === 'GET') return { segments: SEGMENTS };
  if (url.startsWith('/api/campaigns/contacts')) return { contacts: [], total: 0, excluded: 0 };
  if (extra[`${method} ${url}`]) return extra[`${method} ${url}`](body);
  return {};
};

describe('saved segments', () => {
  test('load fills the picker; nothing picked keeps Archive hidden', async () => {
    const b = boot(segAnswer());
    await b.w.__t.ycSegLoad();
    const opts = [...b.$('f-segment').options].map((o) => o.textContent);
    expect(opts).toEqual(['—', 'Everyone', 'Ch7 VIPs']);
    expect(b.$('f-segment-archive').classList.contains('hidden')).toBe(true);
  });

  test('ycSegCurrentFilter reads the whole bar — only set fields, channel always, stage as an array', () => {
    const b = boot(segAnswer());
    expect(b.w.__t.ycSegCurrentFilter()).toEqual({ channel: 'email' });
    b.$('f-tags').value = ' vip , intake ,';
    const o = addTypeOption(b, 'Bankruptcy', 'Chapter 7');
    o.selected = true;
    b.$('f-case-stage').value = 'Open';
    b.$('f-open-after').value = '2026-01-01';
    expect(b.w.__t.ycSegCurrentFilter()).toEqual({
      channel: 'email', tags: ['vip', 'intake'], case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
      case_stage: ['Open'], case_open_after: '2026-01-01',
    });
  });

  test('picking a segment sets the bar and searches with its filter', async () => {
    const b = boot(segAnswer());
    await b.w.__t.ycSegLoad();
    addTypeOption(b, 'Bankruptcy', 'Chapter 7');
    b.$('f-segment').value = '5';
    b.w.__t.ycSegApply();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.$('f-tags').value).toBe('vip');
    expect(b.$('f-case-stage').value).toBe('Open');
    expect(b.$('f-open-after').value).toBe('2026-01-01');
    expect(b.$('f-segment-archive').classList.contains('hidden')).toBe(false);
    const search = b.calls.find((c) => c.url.startsWith('/api/campaigns/contacts'));
    expect(search).toBeTruthy();
    const p = new URLSearchParams(search.url.split('?')[1]);
    expect(p.get('tags')).toBe('vip');
    expect(p.get('case_type')).toBe('Bankruptcy');
    expect(p.get('case_subtype')).toBe('Chapter 7');
    expect(p.get('case_stage')).toBe('Open');
    expect(p.get('case_open_after')).toBe('2026-01-01');
  });

  test('a same-channel apply never runs onChannelChange (it clears compose attachments); a cross-channel one does', async () => {
    const b = boot(segAnswer());
    await b.w.__t.ycSegLoad();
    // Sentinel: onChannelChange → populateSenders rebuilds #c-sender, so a
    // hand-planted option surviving the apply proves it did not run.
    const sentinel = b.w.document.createElement('option');
    sentinel.id = 'seg-sentinel';
    b.$('c-sender').appendChild(sentinel);
    b.$('f-segment').value = '3';          // 'Everyone' — channel email, same as the bar's default
    b.w.__t.ycSegApply();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.$('seg-sentinel')).not.toBeNull();

    const smsSeg = { id: 8, name: 'Texters', filter: { channel: 'sms' }, created_by: 6, archived: false };
    const c = boot((url, method) => (url === '/api/campaigns/segments' && method === 'GET' ? { segments: [smsSeg] }
      : url.startsWith('/api/campaigns/contacts') ? { contacts: [], total: 0, excluded: 0 } : {}));
    await c.w.__t.ycSegLoad();
    const s2 = c.w.document.createElement('option');
    s2.id = 'seg-sentinel';
    c.$('c-sender').appendChild(s2);
    c.$('f-segment').value = '8';
    c.w.__t.ycSegApply();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.$('f-channel').value).toBe('sms');
    expect(c.$('seg-sentinel')).toBeNull();   // populateSenders rebuilt the list
  });

  test('a case type the vocabulary lost falls back to Any with a warning — the search drops it visibly, not silently', async () => {
    const b = boot(segAnswer());
    await b.w.__t.ycSegLoad();
    b.$('f-segment').value = '5';       // no Chapter 7 option injected
    b.w.__t.ycSegApply();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.toasts.some((t) => t.icon === 'warning' && /no longer exists/.test(t.title))).toBe(true);
    const search = b.calls.find((c) => c.url.startsWith('/api/campaigns/contacts'));
    expect(new URLSearchParams(search.url.split('?')[1]).get('case_type')).toBeNull();
  });

  test('save: a kept name UPDATEs the picked segment (PUT); a new name POSTs; the picker re-selects the saved one', async () => {
    const put = [];
    const post = [];
    const listed = [...SEGMENTS];
    const answers = (url, method, body) => {
      if (url === '/api/campaigns/segments' && method === 'GET') return { segments: listed };
      if (url === '/api/campaigns/segments/5' && method === 'PUT') { put.push(body); return { success: true, id: 5 }; }
      if (url === '/api/campaigns/segments' && method === 'POST') {
        post.push(body);
        listed.push({ id: 9, name: body.name, filter: body.filter, created_by: 6, archived: false });
        return { success: true, id: 9 };
      }
      if (url.startsWith('/api/campaigns/contacts')) return { contacts: [], total: 0, excluded: 0 };
      return {};
    };
    let name = 'Ch7 VIPs';
    const b = boot(answers, { swalFire: async (o) => (o.input === 'text' ? { isConfirmed: true, value: name } : { isConfirmed: false }) });
    await b.w.__t.ycSegLoad();
    b.$('f-segment').value = '5';
    b.$('f-tags').value = 'vip';
    await b.w.__t.ycSegSave();
    expect(put).toHaveLength(1);
    expect(put[0].name).toBe('Ch7 VIPs');
    expect(put[0].filter).toEqual({ channel: 'email', tags: ['vip'] });
    expect(post).toHaveLength(0);

    name = 'A new list';
    await b.w.__t.ycSegSave();
    expect(post).toHaveLength(1);
    expect(post[0].name).toBe('A new list');
    expect(b.$('f-segment').value).toBe('9');
  });

  test('archive PATCHes and clears the pick; Clear resets the picker too', async () => {
    const patches = [];
    const b = boot(segAnswer({ 'PATCH /api/campaigns/segments/5': (body) => { patches.push(body); return { success: true }; } }),
      { swalFire: async () => ({ isConfirmed: true }) });
    await b.w.__t.ycSegLoad();
    b.$('f-segment').value = '5';
    b.w.__t.ycSegApply();
    await b.w.__t.ycSegArchive();
    expect(patches).toEqual([{ archived: true }]);
    expect(b.$('f-segment').value).toBe('');
    b.$('f-segment').value = '3';
    b.w.__t.clearFilters();
    expect(b.$('f-segment').value).toBe('');
    expect(b.$('f-segment-archive').classList.contains('hidden')).toBe(true);
  });
});

describe('Stats dialog (C4 reporting)', () => {
  const CAMPAIGN = {
    campaign_id: 70, type: 'email', class: 'marketing', topic_key: 'newsletter', sender: 'news@news.test',
    results: { sent: 4, failed: 0, skipped: 0, sending: 0, unknown: 0, pending: 0 },
    delivery: { delivered: 3, bounced: 1, complained: 1, unsubscribed: 2 },
    transport: { held: true, held_reason: 'complaint rate 0.40%', bounce_rate: 0.25, complaint_rate: 0.004, delivered: 240, enough: true },
  };
  const statsAnswer = (campaign) => (url) => {
    if (url === '/api/campaigns/70') return campaign;
    if (url === '/api/campaigns/70/results') return [];
    return { segments: [] };
  };

  test('marketing email shows delivered / bounced / complaints / unsubscribed and the transport line with the HOLD', async () => {
    const b = boot(statsAnswer(CAMPAIGN));
    await b.w.__t.viewStats(70);
    const dlg = b.dialogs.pop();
    expect(dlg.title).toBe('Campaign #70 Stats');
    expect(dlg.html).toContain('<strong>Delivered:</strong> 3');
    expect(dlg.html).toContain('<strong>Bounced:</strong> 1');
    expect(dlg.html).toContain('<strong>Unsubscribed:</strong> 2');
    expect(dlg.html).toContain('bounce 25.00%');
    expect(dlg.html).toContain('complaints 0.40%');
    expect(dlg.html).toContain('HELD — complaint rate 0.40%');
    expect(dlg.html).not.toContain('low volume');
  });

  test('an operational campaign (no delivery block from the server) renders no delivery or transport line', async () => {
    const { delivery, transport, ...operational } = { ...CAMPAIGN, class: 'operational', topic_key: null };
    const b = boot(statsAnswer(operational));
    await b.w.__t.viewStats(70);
    const dlg = b.dialogs.pop();
    expect(dlg.html).not.toContain('Delivered:');
    expect(dlg.html).not.toContain('Transport (24 h)');
  });

  test('below-volume rates say so instead of pretending precision', async () => {
    const b = boot(statsAnswer({ ...CAMPAIGN, transport: { held: false, held_reason: null, bounce_rate: null, complaint_rate: null, delivered: 3, enough: false } }));
    await b.w.__t.viewStats(70);
    const dlg = b.dialogs.pop();
    expect(dlg.html).toContain('bounce —');
    expect(dlg.html).toContain('low volume, rates not decisive');
  });
});
