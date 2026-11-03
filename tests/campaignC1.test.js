// tests/campaignC1.test.js
//
/**
 * YisraMail C1 — campaignService unit matrix (ref/YISRAMAIL_DESIGN.md §6.1, §6.4):
 * createCampaign's class / topic / cap / confirmCount / kill-switch validation, the
 * over-cap and marketing audit rows, the stagger arithmetic and the pump, the pump
 * bound, the reservation's error classification, and isTransientError unchanged.
 * The engine-level behaviour (the reservation on real rows, the claim quota, the
 * rate window) is tests/campaignC1.mysql.test.js.
 *
 * The scripted db honours what createCampaign sends: app_settings by key, the
 * email_credentials row by email, the topic row by key; every INSERT is recorded.
 * Run: npx jest tests/campaignC1.test.js
 */
'use strict';

jest.mock('../lib/taskQueue', () => {
  const actual = jest.requireActual('../lib/taskQueue');
  return { ...actual, enqueueJobDispatch: jest.fn(async () => true) };
});

const campaignService = require('../services/campaignService');
const taskQueue = require('../lib/taskQueue');

const ADMIN = { type: 'jwt', roles: ['admin'], userId: 6, username: 'fred' };
const STAFF = { type: 'jwt', roles: ['staff'], userId: 9, username: 'sam' };
const SENDERS = {
  'ops@firm.test': { id: 4, bulk_ok: 0 },
  'news@news.test': { id: 17, bulk_ok: 1 },
};
const TOPICS = {
  newsletter: { channel: 'email', consent_model: 'opt_out', active: 1 },
  sms_promo: { channel: 'sms', consent_model: 'opt_in', active: 1 },
  old_news: { channel: 'email', consent_model: 'opt_out', active: 0 },
};

function makeDb(settings = {}) {
  const inserts = { campaigns: [], jobs: [], pump: [], audit: [], contacts: [] };
  const sqls = [];
  const query = jest.fn(async (raw, p = []) => {
    const sql = raw.replace(/\s+/g, ' ').trim();
    sqls.push(sql);
    if (/FROM app_settings WHERE `key` IN/.test(sql)) return [p[0].filter((k) => k in settings).map((k) => ({ key: k, value: settings[k] }))];
    if (/FROM email_credentials WHERE email = \?/.test(sql)) return [SENDERS[p[0]] ? [SENDERS[p[0]]] : []];
    if (/FROM comm_topics WHERE topic_key = \?/.test(sql)) return [TOPICS[p[0]] ? [TOPICS[p[0]]] : []];
    if (/^INSERT INTO campaigns /.test(sql)) { inserts.campaigns.push(p); return [{ insertId: 77 }]; }
    if (/^INSERT INTO campaign_contacts/.test(sql)) { inserts.contacts.push(p[0]); return [{}]; }
    if (/^INSERT INTO scheduled_jobs .* VALUES \?/.test(sql)) { inserts.jobs.push(...p[0]); return [{}]; }
    if (/^INSERT INTO scheduled_jobs /.test(sql)) { inserts.pump.push(p); return [{ insertId: 900 }]; }
    if (/^INSERT INTO admin_audit_log/.test(sql)) { inserts.audit.push(p); return [{}]; }
    throw new Error(`unscripted: ${sql}`);
  });
  return { query, sqls, inserts, withTransaction: (fn) => fn({ query }) };
}

const ids = (n, dupes = 0) => [...Array.from({ length: n }, (_, i) => i + 1), ...Array.from({ length: dupes }, (_, i) => i + 1)];
const base = { type: 'email', sender: 'ops@firm.test', subject: 'S', body: '<p>B</p>', createdBy: 6 };

beforeEach(() => {
  taskQueue.enqueueJobDispatch.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('class and topic validation', () => {
  test('class: exactly "operational" or "marketing" — 400 bad_class otherwise, before any read', async () => {
    for (const klass of ['Operational', 'MARKETING', 'promo', '', null, 1]) {
      const db = makeDb();
      await expect(campaignService.createCampaign(db, { ...base, contactIds: [1], klass })).rejects.toMatchObject({ status: 400, code: 'bad_class' });
      expect(db.sqls).toEqual([]);
    }
  });
  test('absent class = operational (the default)', async () => {
    const db = makeDb();
    expect(await campaignService.createCampaign(db, { ...base, contactIds: [1] })).toMatchObject({ class: 'operational', overCap: false, paced: false });
    expect(db.inserts.campaigns[0].slice(0, 4)).toEqual(['email', 'operational', null, null]);
  });
  test('a topic on an operational campaign → 400; marketing SMS → 422 (D1)', async () => {
    await expect(campaignService.createCampaign(makeDb(), { ...base, contactIds: [1], topicKey: 'newsletter' })).rejects.toMatchObject({ status: 400, code: 'topic_not_allowed' });
    await expect(campaignService.createCampaign(makeDb({ marketing_send_enabled: '1' }), { ...base, type: 'sms', sender: '2485550000', contactIds: [1], klass: 'marketing', auth: ADMIN }))
      .rejects.toMatchObject({ status: 422, code: 'marketing_sms_refused' });
  });
  test('marketing topic: exists, an EMAIL topic, active, topic-shaped; "marketing" / "all" are scopes, not topics', async () => {
    const mk = { ...base, sender: 'news@news.test', contactIds: [1, 2], klass: 'marketing', auth: ADMIN };
    for (const topicKey of [null, '', 'sms_promo', 'old_news', 'missing', 'marketing', 'all', 'News Letter', 'x'.repeat(41)]) {
      await expect(campaignService.createCampaign(makeDb({ marketing_send_enabled: '1' }), { ...mk, topicKey })).rejects.toMatchObject({ status: 400 });
    }
    expect(await campaignService.createCampaign(makeDb({ marketing_send_enabled: '1' }), { ...mk, topicKey: 'newsletter' })).toMatchObject({ class: 'marketing' });
  });
});

describe('the kill switch at create (fail closed: anything but exactly "1" is off)', () => {
  const mk = { ...base, sender: 'news@news.test', contactIds: [1], klass: 'marketing', topicKey: 'newsletter', auth: ADMIN };
  test.each([[undefined], ['0'], [''], [' 1'], ['1 '], ['true'], ['yes'], ['01']])('marketing_send_enabled %p → 422 marketing_disabled, nothing written', async (v) => {
    const db = makeDb(v === undefined ? {} : { marketing_send_enabled: v });
    await expect(campaignService.createCampaign(db, mk)).rejects.toMatchObject({ status: 422, code: 'marketing_disabled' });
    expect(db.inserts.campaigns).toEqual([]);
  });
  test('"1" → the next rules apply (capability 403 for staff; admin creates)', async () => {
    await expect(campaignService.createCampaign(makeDb({ marketing_send_enabled: '1' }), { ...mk, auth: STAFF })).rejects.toMatchObject({ status: 403, code: 'bulk_capability_required' });
    await expect(campaignService.createCampaign(makeDb({ marketing_send_enabled: '1' }), { ...mk, sender: 'ops@firm.test' })).rejects.toMatchObject({ status: 400, code: 'marketing_requires_bulk_sender' });
    const db = makeDb({ marketing_send_enabled: '1' });
    expect(await campaignService.createCampaign(db, mk)).toMatchObject({ class: 'marketing', paced: true });
    expect(db.inserts.audit).toHaveLength(1);
    expect(db.inserts.audit[0][0]).toBe('campaign_marketing_create');
    expect(JSON.parse(db.inserts.audit[0][10])).toMatchObject({ campaign_id: 77, class: 'marketing', topic_key: 'newsletter', count: 1 });
  });
});

describe('the operational cap (deduped) and the over-cap path (D16)', () => {
  test('cap from the setting; blank / zero / negative / not a number → 50', async () => {
    for (const v of [undefined, '', '0', '-5', 'abc']) {
      const s = v === undefined ? {} : { campaign_operational_cap: v };
      expect(await campaignService.createCampaign(makeDb(s), { ...base, contactIds: ids(50) })).toMatchObject({ overCap: false });
      await expect(campaignService.createCampaign(makeDb(s), { ...base, contactIds: ids(51) })).rejects.toMatchObject({ status: 403, extra: { count: 51, cap: 50 } });
    }
    expect(await campaignService.createCampaign(makeDb({ campaign_operational_cap: '3' }), { ...base, contactIds: ids(3) })).toMatchObject({ overCap: false });
    await expect(campaignService.createCampaign(makeDb({ campaign_operational_cap: '3' }), { ...base, contactIds: ids(4) })).rejects.toMatchObject({ status: 403 });
  });
  test('the cap counts DEDUPED ids: 50 distinct among 70 raw is within it', async () => {
    expect(await campaignService.createCampaign(makeDb(), { ...base, contactIds: ids(50, 20) })).toMatchObject({ contactCount: 50, overCap: false });
  });
  test('over the cap: capability first (403, even with the right count), then the typed count (409 naming the REAL count)', async () => {
    await expect(campaignService.createCampaign(makeDb(), { ...base, contactIds: ids(51, 9), auth: STAFF, confirmCount: 51 })).rejects.toMatchObject({ status: 403 });
    await expect(campaignService.createCampaign(makeDb(), { ...base, contactIds: ids(51, 9), auth: undefined, confirmCount: 51 })).rejects.toMatchObject({ status: 403 });
    for (const confirmCount of [undefined, null, '', 60, 50, 52, '60', 'fifty-one']) {
      await expect(campaignService.createCampaign(makeDb(), { ...base, contactIds: ids(51, 9), auth: ADMIN, confirmCount }))
        .rejects.toMatchObject({ status: 409, code: 'over_cap_confirmation', extra: { count: 51, cap: 50 }, message: expect.stringContaining('Type 51') });
    }
    for (const confirmCount of [51, '51']) {
      expect(await campaignService.createCampaign(makeDb(), { ...base, contactIds: ids(51, 9), auth: ADMIN, confirmCount })).toMatchObject({ overCap: true, paced: true, contactCount: 51 });
    }
  });
  test('the over-cap audit row (tool campaign_over_cap) and the stored confirmation; a bulk_ok sender only over the cap', async () => {
    const db = makeDb({ campaign_operational_cap: '2' });
    await campaignService.createCampaign(db, { ...base, sender: 'news@news.test', contactIds: [5, 6, 7], auth: ADMIN, confirmCount: 3, request: { route: '/api/campaigns', method: 'POST', ip: '198.51.100.7', userAgent: 'UA' } });
    expect(db.inserts.campaigns[0].slice(0, 5)).toEqual(['email', 'operational', null, 3, 'news@news.test']);
    const a = db.inserts.audit[0];
    expect(a.slice(0, 6)).toEqual(['campaign_over_cap', 6, 'fred', '/api/campaigns', 'POST', 'success']);
    expect([a[8], a[9]]).toEqual(['198.51.100.7', 'UA']);
    expect(JSON.parse(a[10])).toEqual({ campaign_id: 77, class: 'operational', type: 'email', sender: 'news@news.test', count: 3, topic_key: null, cap: 2, rate: 60, confirmed_count: 3 });
    await expect(campaignService.createCampaign(makeDb({ campaign_operational_cap: '3' }), { ...base, sender: 'news@news.test', contactIds: [5, 6, 7], auth: ADMIN }))
      .rejects.toMatchObject({ status: 400, code: 'bulk_sender_refused', message: 'Operational campaigns cannot send from a marketing transport (news@news.test)' });
  });
  test('over-cap SMS is allowed too (D16) — paced, no email lookup', async () => {
    const db = makeDb({ campaign_operational_cap: '1' });
    expect(await campaignService.createCampaign(db, { ...base, type: 'sms', sender: '2485550000', contactIds: [1, 2], auth: ADMIN, confirmCount: 2 })).toMatchObject({ overCap: true, paced: true });
    expect(db.sqls.some((s) => /email_credentials/.test(s))).toBe(false);
  });
});

describe('pacing: the stagger, the pump, its doorbell', () => {
  test('paced jobs are 60/rate seconds apart from jobTime; ONE pump job named campaign:{id}:pump, due at jobTime, rung', async () => {
    const db = makeDb({ campaign_operational_cap: '2', campaign_marketing_rate: '120' });
    const before = Date.now();
    await campaignService.createCampaign(db, { ...base, contactIds: [1, 2, 3, 4], auth: ADMIN, confirmCount: 4 });
    const times = db.inserts.jobs.map((j) => j[1].getTime());
    expect(times.slice(1).map((t, i) => t - times[i])).toEqual([500, 500, 500]);
    expect(times[0]).toBeGreaterThanOrEqual(before);
    expect(db.inserts.jobs.map((j) => j[3])).toEqual([1, 2, 3, 4].map((c) => `campaign:77:send:${c}`));
    expect(db.inserts.pump).toHaveLength(1);
    const [due, name, data, key] = db.inserts.pump[0];
    expect([name, key, JSON.parse(data)]).toEqual(['campaign:77:pump', 'campaign:77:pump', { type: 'campaign_pump', campaign_id: 77 }]);
    expect(due.getTime()).toBe(Math.floor(times[0] / 1000) * 1000);              // floored: DATETIME rounds
    expect(taskQueue.enqueueJobDispatch).toHaveBeenCalledWith(900, db.inserts.jobs[0][1]);
  });
  test('within the cap: one jobTime for every job, no pump, no doorbell', async () => {
    const db = makeDb({ campaign_marketing_rate: '120' });
    await campaignService.createCampaign(db, { ...base, contactIds: [1, 2, 3] });
    expect(new Set(db.inserts.jobs.map((j) => j[1].getTime())).size).toBe(1);
    expect(db.inserts.pump).toEqual([]);
    expect(taskQueue.enqueueJobDispatch).not.toHaveBeenCalled();
  });
  test('rate blank / zero / not a number → 60/min (1 s apart)', async () => {
    for (const v of ['', '0', 'fast']) {
      const db = makeDb({ campaign_operational_cap: '1', campaign_marketing_rate: v });
      await campaignService.createCampaign(db, { ...base, contactIds: [1, 2], auth: ADMIN, confirmCount: 2 });
      expect(db.inserts.jobs[1][1] - db.inserts.jobs[0][1]).toBe(1000);
    }
  });
  test('pumpBound: rate × the 55 s re-arm interval, at least 1 — one tick never rings more than the rate per minute', () => {
    expect([60, 120, 2.9, 0.5, 1, 12].map(campaignService.pumpBound)).toEqual([55, 110, 2, 1, 1, 11]);
    for (const rate of [1, 2, 7, 12, 60, 120, 1000]) {
      expect(campaignService.pumpBound(rate) * (60000 / campaignService.PUMP_REARM_MS)).toBeLessThanOrEqual(Math.max(rate, 60000 / campaignService.PUMP_REARM_MS));
    }
  });
  test('scheduledTime: at most MAX_SCHEDULE_DAYS (366) ahead — 365 days accepted, 367 refused before anything is written', async () => {
    const { DateTime } = require('luxon');
    const local = (days) => DateTime.now().setZone(process.env.FIRM_TIMEZONE || 'America/Detroit').plus({ days }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    expect(campaignService.MAX_SCHEDULE_DAYS).toBe(366);
    const ok = makeDb();
    expect(await campaignService.createCampaign(ok, { ...base, contactIds: [1], scheduledTime: local(365) })).toMatchObject({ status: 'scheduled' });
    for (const t of [local(367), '2926-06-01T09:00:00', '9500-01-01T09:00:00']) {
      const db = makeDb();
      await expect(campaignService.createCampaign(db, { ...base, contactIds: [1], scheduledTime: t }))
        .rejects.toMatchObject({ status: 400, code: 'schedule_too_far', extra: { max_days: 366 }, message: expect.stringContaining('366 days') });
      expect(db.inserts.campaigns).toEqual([]);
    }
  });
});

describe('the reservation error classification (isAmbiguousSendError)', () => {
  const E = (props, msg = 'x') => Object.assign(new Error(msg), props);
  test.each([
    ['SMTP 421 reply', E({ responseCode: 421, code: 'EENVELOPE' }), false],
    ['SMTP 550 reply', E({ responseCode: 550, code: 'EENVELOPE' }), false],
    ['SMTP auth', E({ code: 'EAUTH', responseCode: 535 }), false],
    ['Gmail API 503', E({ status: 503 }, 'Gmail API 503: backend error'), false],
    ['RingCentral SMS 429', E({}, 'RingCentral SMS 429: rate'), false],
    ['Quo API 500', E({}, 'Quo API 500: {}'), false],
    ['connect refused', E({ code: 'ECONNREFUSED' }), false],
    ['DNS', E({ code: 'ENOTFOUND' }), false],
    ['fetch failed, connect refused', E({ cause: { code: 'ECONNREFUSED' } }, 'fetch failed'), false],
    ['T1 fence', E({ code: 'bulk_sender_refused' }), false],
    ['mysql lost (pre-send read)', E({ code: 'PROTOCOL_CONNECTION_LOST' }), false],
    ['unrecognized', E({}, 'something odd'), false],
    ['socket drop', E({ code: 'ESOCKET' }), true],
    ['timeout', E({ code: 'ETIMEDOUT' }), true],
    ['reset', E({ code: 'ECONNRESET' }), true],
    ['closed unexpectedly', E({ code: 'ECONNECTION' }, 'Connection closed unexpectedly'), true],
    ['fetch failed, socket', E({ cause: { code: 'UND_ERR_SOCKET' } }, 'fetch failed'), true],
    ['abort/timeout', E({ name: 'TimeoutError' }, 'The operation was aborted due to timeout'), true],
    ['timeout in the message', E({}, 'Greeting never received: timed out'), true],
    // an SMTP reply code forces DEFINITE even when the reply text says "Timeout" (a real SES 421)
    ['SES 421 "Timeout waiting for data"', E({ responseCode: 421, code: 'EMESSAGE' }, '421 Timeout waiting for data from client'), false],
    // code first: our own fences and MySQL server errors are definite whatever the message says
    ['T1 fence naming a "timeout" address', E({ code: 'bulk_sender_refused' }, 'bulk_sender_refused: timeout@x.test is a marketing transport'), false],
    ['MySQL lock wait timeout (pre-send lookup)', E({ code: 'ER_LOCK_WAIT_TIMEOUT', sqlState: 'HY000' }, 'Lock wait timeout exceeded; try restarting transaction'), false],
    ['MySQL server error with a reset message', E({ sqlState: '08S01' }, 'connection reset by server'), false],
    // …but a DB CONNECT timeout inside the send span cannot be told from a provider socket: ambiguous (conservative)
    ['mysql2 connect ETIMEDOUT', E({ code: 'ETIMEDOUT', fatal: true }, 'connect ETIMEDOUT'), true],
  ])('%s → ambiguous %p', (_, err, want) => {
    expect(campaignService.isAmbiguousSendError(err)).toBe(want);
  });
});

describe('isTransientError — unchanged by C1', () => {
  test.each([
    [{ code: 'ETIMEDOUT' }, true], [{ code: 'PROTOCOL_CONNECTION_LOST' }, true], [{ responseCode: 451 }, true],
    [{ responseCode: 550 }, false], [{ code: 'bulk_sender_refused', message: 'timeout 503' }, false],
    [{ message: 'Quo API 503: down' }, true], [{ message: 'RingCentral SMS 429: slow' }, true],
    [{ message: 'SMTP 554 rejected' }, false], [{ message: 'odd' }, false],
  ])('%p → %p', (props, want) => {
    expect(campaignService.isTransientError(Object.assign(new Error(props.message || 'e'), props))).toBe(want);
  });
});
