// tests/campaignC1.routes.test.js
//
/**
 * YisraMail C1 — routes/campaign.js: createCampaign's refusals reach the client
 * with their status and code (422 marketing dark, 403 over the cap without
 * campaigns.bulk, 409 naming the real count, 400 a bad class), req.auth reaches
 * the capability check, PATCH pause / resume / cancel transitions (404 / 409),
 * the contact search validates class / topic, and compose-options.
 * Auth middleware is stubbed (role chosen per request); the routes and the
 * service run for real over a scripted db that honours the status predicates.
 * Run: npx jest tests/campaignC1.routes.test.js
 */
'use strict';

jest.mock('../lib/auth.jwtOrApiKey', () => (req, res, next) => {
  const role = req.headers['x-test-role'] || 'staff';
  req.auth = { type: 'jwt', roles: [role], userId: role === 'admin' ? 6 : 9, username: role };
  next();
});
jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});

const express = require('express');

function makeDb({ settings = {}, campaigns = {} } = {}) {
  const T = { campaigns: JSON.parse(JSON.stringify(campaigns)), audit: [], sqls: [] };
  const query = async (raw, p = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    T.sqls.push({ sql, p });
    if (/FROM app_settings WHERE `key` IN/.test(sql)) return [p[0].filter((k) => k in settings).map((k) => ({ key: k, value: settings[k] }))];
    if (/FROM email_credentials WHERE email = \?/.test(sql)) return [p[0] === 'ops@firm.test' ? [{ id: 4, bulk_ok: 0 }] : p[0] === 'news@news.test' ? [{ id: 17, bulk_ok: 1 }] : []];
    if (/FROM email_credentials WHERE bulk_ok = 1/.test(sql)) return [[{ email: 'news@news.test', from_name: 'News' }]];
    if (/FROM comm_topics WHERE channel = 'email' AND active = 1/.test(sql)) return [[{ topic_key: 'newsletter', label: 'Newsletter', description: 'd', consent_model: 'opt_out' }]];
    if (/^INSERT INTO campaigns /.test(sql)) return [{ insertId: 77 }];
    if (/^INSERT INTO admin_audit_log/.test(sql)) { T.audit.push(p); return [{}]; }
    if (/^INSERT INTO/.test(sql)) return [{ insertId: 900 }];
    const upd = /^UPDATE campaigns SET status = '(\w+)', updated_at = NOW\(\) WHERE campaign_id = \? AND status (?:IN \(([^)]*)\)|= '(\w+)')/.exec(sql);
    if (upd) {
      const allowed = upd[2] ? upd[2].split(',').map((s) => s.trim().replace(/'/g, '')) : [upd[3]];
      const c = T.campaigns[p[0]];
      if (c && allowed.includes(c.status)) { c.status = upd[1]; return [{ affectedRows: 1 }]; }
      return [{ affectedRows: 0 }];
    }
    if (/^SELECT status FROM campaigns WHERE campaign_id = \?/.test(sql)) return [T.campaigns[p[0]] ? [{ status: T.campaigns[p[0]].status }] : []];
    if (/^UPDATE campaigns SET status = 'canceled'/.test(sql)) { T.campaigns[p[0]].status = 'canceled'; return [{ affectedRows: 1 }]; }
    if (/^DELETE FROM scheduled_jobs/.test(sql)) return [{ affectedRows: 2 }];
    if (/^UPDATE scheduled_jobs SET scheduled_time = scheduled_time \+ INTERVAL/.test(sql)) { T.parked = (T.parked || 0) + 1; return [{ affectedRows: 3 }]; }
    if (/^SELECT class, bulk_confirmed_count FROM campaigns/.test(sql)) return [[{ class: 'operational', bulk_confirmed_count: null }]];
    if (/^UPDATE scheduled_jobs sj JOIN/.test(sql)) { T.pulled = (T.pulled || 0) + 1; return [{ affectedRows: 3 }]; }
    if (/MIN\(scheduled_time\) AS due/.test(sql)) return [[{ due: null, n: 0 }]];
    if (/AS total/.test(sql)) return [[{ total: 2, done: 0 }]];
    if (/FROM contacts c/.test(sql)) return [[]];
    throw new Error(`unscripted: ${sql}`);
  };
  return { T, query, withTransaction: (fn) => fn({ query }) };
}

let currentDb, server, base;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.db = currentDb; next(); });
app.use(require('../routes/campaign'));

beforeAll(async () => {
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
beforeEach(() => {
  for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

async function call(method, url, body, role = 'staff') {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
const email = { type: 'email', sender: 'ops@firm.test', subject: 'S', body: '<p>B</p>' };
const many = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('POST /api/campaigns — C1 refusals carry status + code', () => {
  test('marketing while the switch is off → 422 marketing_disabled (whatever the role)', async () => {
    currentDb = makeDb();
    for (const role of ['staff', 'admin']) {
      const r = await call('POST', '/api/campaigns', { ...email, sender: 'news@news.test', class: 'marketing', topic_key: 'newsletter', contactIds: [1] }, role);
      expect(r).toMatchObject({ status: 422, json: { code: 'marketing_disabled', error: expect.stringMatching(/switched off/) } });
    }
    currentDb = makeDb({ settings: { marketing_send_enabled: '0' } });
    expect((await call('POST', '/api/campaigns', { ...email, class: 'marketing', topic_key: 'newsletter', contactIds: [1] }, 'admin')).status).toBe(422);
  });
  test('a misspelled class → 400 bad_class; a topic on operational → 400', async () => {
    currentDb = makeDb();
    expect(await call('POST', '/api/campaigns', { ...email, class: 'Marketing', contactIds: [1] })).toMatchObject({ status: 400, json: { code: 'bad_class' } });
    expect(await call('POST', '/api/campaigns', { ...email, topic_key: 'newsletter', contactIds: [1] })).toMatchObject({ status: 400, json: { code: 'topic_not_allowed' } });
  });
  test('over the cap: staff → 403 (count named); admin without / with a wrong count → 409 with the real count; the right count → 200 + audited', async () => {
    currentDb = makeDb();
    expect(await call('POST', '/api/campaigns', { ...email, contactIds: [...many(51), 1, 2], confirmCount: 51 }, 'staff'))
      .toMatchObject({ status: 403, json: { code: 'bulk_capability_required', count: 51, cap: 50 } });
    expect(await call('POST', '/api/campaigns', { ...email, contactIds: [...many(51), 1, 2] }, 'admin'))
      .toMatchObject({ status: 409, json: { code: 'over_cap_confirmation', count: 51, cap: 50 } });
    expect(await call('POST', '/api/campaigns', { ...email, contactIds: [...many(51), 1, 2], confirmCount: 53 }, 'admin'))
      .toMatchObject({ status: 409, json: { count: 51 } });
    const ok = await call('POST', '/api/campaigns', { ...email, contactIds: [...many(51), 1, 2], confirmCount: 51 }, 'admin');
    expect(ok).toMatchObject({ status: 200, json: { campaignId: 77, contactCount: 51, overCap: true, paced: true, class: 'operational' } });
    const a = currentDb.T.audit[0];
    expect(a.slice(0, 5)).toEqual(['campaign_over_cap', 6, 'admin', '/api/campaigns', 'POST']);
  });
  test('within the cap stays open to staff (200)', async () => {
    currentDb = makeDb();
    expect(await call('POST', '/api/campaigns', { ...email, contactIds: many(50) }, 'staff')).toMatchObject({ status: 200, json: { overCap: false } });
  });
});

describe('PATCH /api/campaigns/:id — cancel, pause, resume', () => {
  test('pause from scheduled / sending; 409 from anything else; 404 when missing', async () => {
    currentDb = makeDb({ campaigns: { 1: { status: 'sending' }, 2: { status: 'scheduled' }, 3: { status: 'sent' }, 4: { status: 'paused' } } });
    expect(await call('PATCH', '/api/campaigns/1', { status: 'paused' })).toMatchObject({ status: 200, json: { paused: true, parked: 3 } });
    expect(await call('PATCH', '/api/campaigns/2', { status: 'paused' })).toMatchObject({ status: 200 });
    expect(await call('PATCH', '/api/campaigns/3', { status: 'paused' })).toMatchObject({ status: 409, json: { code: 'bad_transition', error: expect.stringContaining('sent') } });
    expect(await call('PATCH', '/api/campaigns/4', { status: 'paused' })).toMatchObject({ status: 409 });
    expect(await call('PATCH', '/api/campaigns/99', { status: 'paused' })).toMatchObject({ status: 404, json: { code: 'not_found' } });
    expect(currentDb.T.campaigns[1].status).toBe('paused');
  });
  test('resume (status sending) from paused only; cancel accepts paused; anything else → 400', async () => {
    currentDb = makeDb({ campaigns: { 1: { status: 'paused' }, 2: { status: 'sending' }, 3: { status: 'paused' } } });
    expect(await call('PATCH', '/api/campaigns/1', { status: 'sending' })).toMatchObject({ status: 200, json: { resumed: true } });
    expect(currentDb.T.campaigns[1].status).toBe('sending');
    expect(await call('PATCH', '/api/campaigns/2', { status: 'sending' })).toMatchObject({ status: 409 });
    expect(await call('PATCH', '/api/campaigns/3', { status: 'canceled' })).toMatchObject({ status: 200, json: { canceled: true, jobsRemoved: 2 } });
    expect((await call('PATCH', '/api/campaigns/2', { status: 'sent' })).status).toBe(400);
  });
});

describe('GET /api/campaigns/contacts and compose-options', () => {
  test('contacts: a bad class / topic → 400; marketing + topic reaches the consent predicate', async () => {
    currentDb = makeDb();
    expect((await call('GET', '/api/campaigns/contacts?channel=email&class=promo')).status).toBe(400);
    expect((await call('GET', '/api/campaigns/contacts?channel=email&topic=newsletter')).status).toBe(400);
    expect((await call('GET', '/api/campaigns/contacts?channel=email&class=marketing&topic=News%20Letter')).status).toBe(400);
    expect((await call('GET', '/api/campaigns/contacts?channel=email&class=marketing&topic=newsletter')).status).toBe(200);
    const q = currentDb.T.sqls.find((s) => /FROM contacts c/.test(s.sql)).sql;
    expect(q).toContain("oo_s.scope IN ('marketing', 'newsletter')");
    await call('GET', '/api/campaigns/contacts?channel=email');
    expect(currentDb.T.sqls.filter((s) => /FROM contacts c/.test(s.sql))[1].sql).toContain('(0 = 1) AS email_opted_out');
  });
  test('compose-options: marketing senders (bulk rows), active email topics, cap, switch, can_bulk by role', async () => {
    currentDb = makeDb({ settings: { campaign_operational_cap: '25' } });
    const s = await call('GET', '/api/campaigns/compose-options', null, 'staff');
    expect(s).toMatchObject({ status: 200, json: { marketing_senders: [{ email: 'news@news.test', from_name: 'News' }], topics: [{ topic_key: 'newsletter', label: 'Newsletter' }],
      operational_cap: 25, marketing_rate: 60, marketing_enabled: false, can_bulk: false } });
    expect((await call('GET', '/api/campaigns/compose-options', null, 'admin')).json.can_bulk).toBe(true);
  });
});
