// tests/unsubActions.routes.test.js
//
/**
 * Email unsubscribe surface (YisraMail P3) — routes/unsubActions.js over the
 * REAL services/unsubService.js and the REAL optoutService writer
 * (ref/YISRAMAIL_DESIGN.md §4.5).
 *
 * WHAT IS LOCKED
 *   - GET never mutates (GET and HEAD): zero write statements reach the DB.
 *   - Every response — 200s, 422s, 429s, 500s — carries Cache-Control
 *     no-store, X-Robots-Tag noindex, Referrer-Policy no-referrer.
 *   - Staff-authored topic labels / descriptions are escaped; the address is
 *     masked on the page.
 *   - No oracle: an unknown token gets the same neutral page shape (200), a
 *     bad topic is 422 for unknown and known tokens alike, and a one-click on
 *     an unknown token is 200 empty.
 *   - One-click (RFC 8058): 200, EMPTY body, never a Location; any content
 *     type (multipart reaches the handler unparsed); JSON Accept changes
 *     nothing; idempotent on STATE (a 2nd one-click writes nothing, a 3rd
 *     after an opt-in writes again); an infrastructure failure is a 500, never
 *     a 200 that drops the unsubscribe.
 *   - The page form: unsubscribe / all / prefs record the right scope, action
 *     and source; marketing scopes only (D18); unknown topics 422 with nothing
 *     written; the free-text note becomes ONE staff task AFTER the commit, or
 *     — with no usable assignee — an IT warning, the note kept in the ledger.
 *   - LIMITERS: reads 30/min/IP, prefs 10/min/IP, one-click NONE (a 429 would
 *     silently drop an unsubscribe from a mail provider's IP).
 *
 * HARNESS: tests/helpers/unsubWorld.js (contactConsentWorld's consent store +
 * the token table), a real express app with server.js's global parsers
 * (json + urlencoded; no multipart). Only the alert sink and createTask are
 * mocked — both are side effects the routes trigger, not the code under test.
 * Every test gets its own client IP (last X-Forwarded-For element), so the
 * module-level limiters never leak between tests.
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../services/taskService', () => ({
  createTask: jest.fn(async () => ({ task_id: 777, action_token: 'x', action_url: 'x' })),
}));

const express = require('express');
const { alert } = require('../lib/alerting');
const { createTask } = require('../services/taskService');
const firmConfig = require('../lib/firmConfig');
const { makeUnsubWorld } = require('./helpers/unsubWorld');

const TOK = 'Ab3dEfGh1jKlMn0pQr5tUv';            // 22-char base62 — the real mint shape
const OTHER = 'Zz9yXw8vUt7sRq6pOn5mLk';
const ADDR = 'pat.doe@example.com';

let W;
let IP;
let ipSeq = 0;
let server;
let base;
let failQueries = false;

beforeAll(async () => {
  firmConfig._test({
    db: { query: async () => [[
      { key: 'firm_name', value: 'Test Firm <b>' },
      { key: 'firm_address', value: '["100 Main St., #2","Springfield, MI 48000"]' },
      { key: 'fe-firm_phone', value: '2485550100' },
      { key: 'firm_attorney_name', value: 'A. Lawyer' },
    ]] },
    resetCache: true,
  });
  await firmConfig.prime();

  const app = express();
  app.use(express.json({ limit: '10mb' }));          // server.js's global parsers
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.db = failQueries ? { query: async () => { throw new Error('db down'); }, getConnection: async () => { throw new Error('db down'); } } : W.db;
    next();
  });
  app.use(require('../routes/unsubActions'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll((done) => {
  firmConfig._test({ db: null, resetCache: true });
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(done);
});

function world(overrides = {}) {
  return makeUnsubWorld({
    tokens: [{ token: TOK, destination: ADDR, topic_key: 'newsletter', campaign_id: 85, contact_id: 1001, send_ref: 'cr-9' }],
    topics: [
      { topic_key: 'newsletter', channel: 'email', label: 'News <script>alert(1)</script>', description: 'Monthly <i>news</i>', consent_model: 'opt_out', active: 1 },
      { topic_key: 'events', channel: 'email', label: 'Events', description: null, consent_model: 'opt_out', active: 1 },
      { topic_key: 'old_list', channel: 'email', label: 'Old list', consent_model: 'opt_out', active: 0 },
      { topic_key: 'sms_marketing', channel: 'sms', label: 'Texts', consent_model: 'opt_in', active: 1 },
    ],
    contacts: [{ contact_id: 1001, contact_name: 'Pat Doe' }],
    emails: [{ id: 501, contact_id: 1001, email: ADDR, email_optout: 0 }],
    settings: { consent_task_user_id: '5' },
    users: [{ user: 5, user_auth: 'authorized' }, { user: 9, user_auth: 'unauthorized' }],
    ...overrides,
  });
}

beforeEach(() => {
  W = world();
  IP = `198.51.100.${++ipSeq}`;
  failQueries = false;
  alert.mockClear();
  createTask.mockClear();
});

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts, headers: { 'x-forwarded-for': IP, ...(opts.headers || {}) } });
const post = (p, body, type = 'application/x-www-form-urlencoded', opts = {}) => fetch(base + p, {
  method: 'POST', redirect: 'manual', body,
  ...opts,
  headers: { 'x-forwarded-for': IP, ...(type ? { 'content-type': type } : {}), ...(opts.headers || {}) },
});
const form = (o) => new URLSearchParams(o).toString();
const prefs = (o, p = `/u/${TOK}/prefs`) => post(p, form(o));

function expectHeaders(res) {
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  expect(res.headers.get('referrer-policy')).toBe('no-referrer');
}

const consentEvents = () => W.events.filter((e) => e.channel === 'email');
const stateOf = (scope) => (W.state('email', ADDR, scope) || {}).state || null;

// ─────────────────────────────────────────────────────────────────────────────
describe('GET /u/:token — the page', () => {
  test('renders the controls: one-click-equivalent button, topic boxes, note, firm block, the case-mail line', async () => {
    const res = await get(`/u/${TOK}`);
    expect(res.status).toBe(200);
    expectHeaders(res);
    const html = await res.text();
    expect(html).toContain('data-u-prefs="1"');
    expect(html).toContain('name="action" value="unsubscribe"');
    expect(html).toContain(`action="/u/${TOK}/prefs"`);
    expect(html).toContain('name="t_newsletter" value="1" checked');
    expect(html).toContain('name="t_events" value="1" checked');
    expect(html).not.toContain('t_old_list');           // inactive topic: not offered
    expect(html).not.toContain('t_sms_marketing');      // another channel: not offered (D18 / email page)
    expect(html).toContain('name="action" value="all"');
    expect(html).toContain('name="note"');
    expect(html).toContain('Email about your case or your appointments is not affected');
    expect(html).toContain('100 Main St., #2, Springfield, MI 48000');
    expect(html).toContain('(248) 555-0100');
    expect(html).toContain('id="prefs"');
  });

  test('staff-authored labels and descriptions are ESCAPED; the address is masked', async () => {
    const html = await (await get(`/u/${TOK}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('News &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Monthly &lt;i&gt;news&lt;/i&gt;');
    expect(html).toContain('Test Firm &lt;b&gt;');
    expect(html).not.toContain(ADDR);
    expect(html).toContain('p******@example.com');
  });

  test('GET and HEAD write NOTHING (link scanners prefetch every GET)', async () => {
    await get(`/u/${TOK}`);
    await get(`/u/${TOK}`, { method: 'HEAD' });
    await get(`/u/${OTHER}`);
    expect(W.writes()).toEqual([]);
    expect(W.events).toEqual([]);
    expect(W.token(TOK).used_at).toBeNull();
    expect(W.unsubUnhandled).toEqual([]);
  });

  test('NO ORACLE: an unknown token gets the neutral page, 200, the same headers, no controls', async () => {
    const res = await get(`/u/${OTHER}`);
    expect(res.status).toBe(200);
    expectHeaders(res);
    const html = await res.text();
    expect(html).toContain("This link isn't valid");
    expect(html).toContain('100 Main St., #2, Springfield, MI 48000');   // contact us
    expect(html).not.toContain('data-u-prefs');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('Unsubscribe from');
  });

  test('the token is case-sensitive: one letter flipped is the neutral page', async () => {
    const flipped = TOK.slice(0, -1) + TOK.slice(-1).toUpperCase();
    expect(flipped).not.toBe(TOK);
    const html = await (await get(`/u/${flipped}`)).text();
    expect(html).not.toContain('data-u-prefs');
  });

  test('already unsubscribed from the topic: says so, no unsubscribe button, the box unticked', async () => {
    W = world({ states: [{ channel: 'email', destination: ADDR, scope: 'newsletter', state: 'opted_out', last_event_id: 1 }] });
    const html = await (await get(`/u/${TOK}`)).text();
    expect(html).toContain("You're unsubscribed from News &lt;script&gt;");
    expect(html).not.toContain('value="unsubscribe"');
    expect(html).toContain('name="t_newsletter" value="1">');
    expect(html).toContain('name="t_events" value="1" checked');
  });

  test('all marketing stopped: says so, every box unticked, no stop-all button', async () => {
    W = world({ states: [{ channel: 'email', destination: ADDR, scope: 'marketing', state: 'opted_out', last_event_id: 1 }] });
    const html = await (await get(`/u/${TOK}`)).text();
    expect(html).toContain("You're unsubscribed from all our marketing email");
    expect(html).not.toContain('value="unsubscribe"');
    expect(html).not.toContain('value="all"');
    expect(html).not.toMatch(/name="t_[a-z_]+" value="1" checked/);
  });

  test('an infrastructure failure is a 500 page with the headers', async () => {
    failQueries = true;
    const res = await get(`/u/${TOK}`);
    expect(res.status).toBe(500);
    expectHeaders(res);
    expect(await res.text()).toContain('Nothing was changed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /u/:token — RFC 8058 one-click', () => {
  const RFC_BODY = 'List-Unsubscribe=One-Click';

  test('200, EMPTY body, no Location; opt_out of the token topic, source one_click, with evidence', async () => {
    const res = await post(`/u/${TOK}`, RFC_BODY, 'application/x-www-form-urlencoded', { headers: { 'user-agent': 'GoogleMailUnsub/1.0' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expectHeaders(res);
    expect(await res.text()).toBe('');
    const ev = consentEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      destination: ADDR, scope: 'newsletter', action: 'opt_out', source: 'one_click',
      contact_id: 1001, send_ref: 'cr-9', provider_event_id: null,
    });
    expect(ev[0].evidence).toEqual({ token: TOK, via: 'rfc8058', ip: IP, user_agent: 'GoogleMailUnsub/1.0', campaign_id: 85 });
    expect(stateOf('newsletter')).toBe('opted_out');
    expect(W.token(TOK).used_at).toBeInstanceOf(Date);
    // a topic opt-out never touches the marketing cache flag on the contact row
    expect(W.email(501).email_optout).toBe(0);
  });

  test('IDEMPOTENT ON STATE: a 2nd one-click writes nothing; after a page opt-in a 3rd writes again', async () => {
    await post(`/u/${TOK}`, RFC_BODY);
    const firstUse = W.token(TOK).used_at;
    const r2 = await post(`/u/${TOK}`, RFC_BODY);
    expect(r2.status).toBe(200);
    expect(consentEvents()).toHaveLength(1);
    expect(W.token(TOK).used_at).toBe(firstUse);         // first use only
    // opt back in through the page
    await prefs({ action: 'prefs', t_newsletter: '1', t_events: '1' });
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([
      ['newsletter', 'opt_out', 'one_click'], ['newsletter', 'opt_in', 'pref_page'],
    ]);
    const r3 = await post(`/u/${TOK}`, RFC_BODY);
    expect(r3.status).toBe(200);
    expect(consentEvents().map((e) => [e.scope, e.action, e.source]).slice(-1)).toEqual([['newsletter', 'opt_out', 'one_click']]);
    expect(stateOf('newsletter')).toBe('opted_out');
  });

  test('ANY content type: multipart (no parser on this path) still 200 and records', async () => {
    const fd = new FormData();
    fd.append('List-Unsubscribe', 'One-Click');
    const res = await fetch(`${base}/u/${TOK}`, { method: 'POST', body: fd, redirect: 'manual', headers: { 'x-forwarded-for': IP } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(consentEvents()).toHaveLength(1);
  });

  test('no body, text/plain, JSON body: all 200 empty', async () => {
    for (const [body, type] of [[undefined, null], ['whatever', 'text/plain'], ['{"a":1}', 'application/json']]) {
      const res = await post(`/u/${TOK}`, body, type);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    }
    expect(consentEvents()).toHaveLength(1);
  });

  test('Accept: application/json changes nothing — still 200 EMPTY (there is no JSON surface)', async () => {
    const res = await post(`/u/${TOK}`, RFC_BODY, 'application/x-www-form-urlencoded', { headers: { accept: 'application/json' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });

  test('NO ORACLE: an unknown token is 200 empty and writes nothing', async () => {
    const res = await post(`/u/${OTHER}`, RFC_BODY);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expectHeaders(res);
    expect(W.writes()).toEqual([]);
  });

  test('NO LIMITER: 40 one-click POSTs from ONE IP all answer 200 (a 429 would drop an unsubscribe)', async () => {
    const results = [];
    for (let i = 0; i < 40; i++) results.push((await post(`/u/${TOK}`, RFC_BODY)).status);
    expect(results.every((s) => s === 200)).toBe(true);
    expect(consentEvents()).toHaveLength(1);
  });

  test('a topic deleted since the mint falls back to all marketing (the unsubscribe is never thrown away)', async () => {
    W = world({ tokens: [{ token: TOK, destination: ADDR, topic_key: 'gone_topic', contact_id: 1001 }] });
    const res = await post(`/u/${TOK}`, RFC_BODY);
    expect(res.status).toBe(200);
    const ev = consentEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ scope: 'marketing', action: 'opt_out', source: 'one_click' });
    expect(ev[0].evidence.topic_missing).toBe('gone_topic');
    expect(W.email(501).email_optout).toBe(1);   // marketing is the scope the row flag caches
  });

  test('a retired (inactive) topic still records ITS scope', async () => {
    W = world({ tokens: [{ token: TOK, destination: ADDR, topic_key: 'old_list' }] });
    await post(`/u/${TOK}`, RFC_BODY);
    expect(consentEvents().map((e) => e.scope)).toEqual(['old_list']);
  });

  test('an infrastructure failure is a 500 — never a 200 that silently drops the unsubscribe', async () => {
    failQueries = true;
    const res = await post(`/u/${TOK}`, RFC_BODY);
    expect(res.status).toBe(500);
    expect(res.headers.get('location')).toBeNull();
    expectHeaders(res);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('POST /u/:token/prefs — the page form', () => {
  test('unsubscribe → opt_out of the token topic, source unsub_page; the page confirms', async () => {
    const res = await prefs({ action: 'unsubscribe' });
    expect(res.status).toBe(200);
    expectHeaders(res);
    const html = await res.text();
    expect(html).toContain("You're unsubscribed from News &lt;script&gt;");
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([['newsletter', 'opt_out', 'unsub_page']]);
    expect(consentEvents()[0].evidence).toMatchObject({ token: TOK, via: 'unsub_page', ip: IP, campaign_id: 85 });
    expect(W.token(TOK).used_at).toBeInstanceOf(Date);
  });

  test('all → opt_out of scope marketing (the contact row\'s cache flag follows)', async () => {
    const html = await (await prefs({ action: 'all', t_newsletter: '1' })).text();
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([['marketing', 'opt_out', 'unsub_page']]);
    expect(stateOf('marketing')).toBe('opted_out');
    expect(W.email(501).email_optout).toBe(1);
    expect(html).toContain("You're unsubscribed from all our marketing email");
  });

  test('prefs: newsletter unticked → opt_out pref_page; ticked again → opt_in pref_page', async () => {
    await prefs({ action: 'prefs', t_events: '1' });
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([['newsletter', 'opt_out', 'pref_page']]);
    await prefs({ action: 'prefs', t_events: '1', t_newsletter: '1' });
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([
      ['newsletter', 'opt_out', 'pref_page'], ['newsletter', 'opt_in', 'pref_page'],
    ]);
    expect(stateOf('newsletter')).toBe('opted_in');
  });

  test('a request that changes nothing writes nothing', async () => {
    const res = await prefs({ action: 'prefs', t_newsletter: '1', t_events: '1' });
    expect(res.status).toBe(200);
    expect(consentEvents()).toEqual([]);
    expect(await res.text()).toContain('Nothing needed changing');
  });

  test('ticking a topic after "stop all" opts marketing back in and keeps every unticked topic out', async () => {
    W = world({ states: [{ channel: 'email', destination: ADDR, scope: 'marketing', state: 'opted_out', last_event_id: 1 }] });
    await prefs({ action: 'prefs', t_events: '1' });
    expect(consentEvents().map((e) => [e.scope, e.action, e.source])).toEqual([
      ['marketing', 'opt_in', 'pref_page'], ['newsletter', 'opt_out', 'pref_page'],
    ]);
    expect(stateOf('marketing')).toBe('opted_in');
    expect(W.email(501).email_optout).toBe(0);
    const html = await (await get(`/u/${TOK}`)).text();
    expect(html).toContain('name="t_events" value="1" checked');
    expect(html).toContain('name="t_newsletter" value="1">');
  });

  test('MARKETING SCOPES ONLY (D18): every scope the form ever records is marketing or an email topic', async () => {
    await prefs({ action: 'all' });
    await prefs({ action: 'prefs', t_newsletter: '1' });
    await prefs({ action: 'unsubscribe' });
    const scopes = new Set(consentEvents().map((e) => e.scope));
    for (const s of scopes) expect(['marketing', 'newsletter', 'events']).toContain(s);
    expect(W.events.every((e) => e.channel === 'email')).toBe(true);
  });

  test('an unknown, inactive, other-channel or "all" topic → 422, NOTHING written', async () => {
    for (const k of ['nope', 'old_list', 'sms_marketing', 'all']) {
      const res = await prefs({ action: 'prefs', [`t_${k}`]: '1', t_newsletter: '1' });
      expect(res.status).toBe(422);
      expectHeaders(res);
      expect(await res.text()).toContain("That request wasn't valid");
    }
    expect(W.events).toEqual([]);
    expect(W.writes()).toEqual([]);
  });

  test('NO ORACLE: a bogus topic is 422 for an UNKNOWN token too (validated before the token is)', async () => {
    const res = await prefs({ action: 'prefs', t_nope: '1' }, `/u/${OTHER}/prefs`);
    expect(res.status).toBe(422);
  });

  test('a bad or missing action → 422, nothing written', async () => {
    for (const body of [{ action: 'everything' }, {}, { action: 'all_mail' }]) {
      const res = await prefs(body);
      expect(res.status).toBe(422);
    }
    expect(W.writes()).toEqual([]);
  });

  test('unknown token with a valid action → the neutral page, 200, nothing written', async () => {
    const res = await prefs({ action: 'all' }, `/u/${OTHER}/prefs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This link isn't valid");
    expect(html).not.toContain('data-u-prefs');
    expect(W.writes()).toEqual([]);
  });

  test('the note → ONE staff task to consent_task_user_id, created AFTER the consent COMMIT', async () => {
    const res = await prefs({ action: 'all', note: '  Please also remove my husband\'s address.  ' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('your note was passed to our office');
    expect(createTask).toHaveBeenCalledTimes(1);
    const [, arg] = createTask.mock.calls[0];
    expect(arg).toMatchObject({ from: 0, to: 5, source: 'consent', link_type: 'contact', link_id: '1001' });
    expect(arg.title).toBe(`Unsubscribe page note from ${ADDR}`);
    expect(arg.title.length).toBeLessThanOrEqual(100);
    expect(arg.desc.startsWith("Please also remove my husband's address.")).toBe(true);
    expect(arg.desc).toContain('opted out of all marketing email');
    expect(arg.desc.length).toBeLessThanOrEqual(1000);
    expect(arg.log_extra.consent_note).toBe("Please also remove my husband's address.");
    // the note rides on the (first) event
    expect(consentEvents()[0].evidence.note).toBe("Please also remove my husband's address.");
    expect(consentEvents()[0].evidence.note_unassigned).toBeUndefined();
    expect(W.log.filter((x) => x === 'BEGIN' || x === 'COMMIT' || x === 'ROLLBACK')).toEqual(['BEGIN', 'COMMIT']);
    expect(alert).not.toHaveBeenCalled();
  });

  test('ORDER, asserted on the engine\'s timeline: COMMIT precedes createTask', async () => {
    const seen = [];
    const realPush = W.log.push.bind(W.log);
    W.log.push = (...xs) => { for (const x of xs) if (x === 'COMMIT' || x === 'BEGIN') seen.push(x); return realPush(...xs); };
    createTask.mockImplementationOnce(async () => { seen.push('createTask'); return { task_id: 778 }; });
    await prefs({ action: 'unsubscribe', note: 'call me' });
    expect(seen).toEqual(['BEGIN', 'COMMIT', 'createTask']);
  });

  test('a note with NO consent change still reaches staff as a task', async () => {
    await prefs({ action: 'prefs', t_newsletter: '1', t_events: '1', note: 'Wrong person — I never signed up.' });
    expect(consentEvents()).toEqual([]);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0][1].desc).toContain('No consent change');
  });

  test('consent_task_user_id UNSET → no task; one IT warning (once per day), the note kept in the ledger', async () => {
    W = world({ settings: {} });
    await prefs({ action: 'all', note: 'Remove me from everything.' });
    expect(createTask).not.toHaveBeenCalled();
    const ev = consentEvents();
    expect(ev[0].evidence).toMatchObject({ note: 'Remove me from everything.', note_unassigned: true });
    const calls = alert.mock.calls.map((c) => c[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: 'consent_task_unassigned', severity: 'warning', group_key: 'consent_task_unassigned',
      dedup_key: `consent_task_unassigned:${new Date().toISOString().slice(0, 10)}`,
    });
    expect(calls[0].title).toBe('consent_task_user_id unset — 1 unsubscribe note unassigned');
  });

  test('UNSET and the note changed nothing → a second warning CARRIES the note (never a silent drop)', async () => {
    W = world({ settings: {} });
    await prefs({ action: 'prefs', t_newsletter: '1', t_events: '1', note: 'Stop mailing my late father.' });
    expect(consentEvents()).toEqual([]);
    const kinds = alert.mock.calls.map((c) => c[1].kind);
    expect(kinds).toEqual(['consent_task_unassigned', 'consent_note_unassigned']);
    const carried = alert.mock.calls[1][1];
    expect(carried.context.note).toBe('Stop mailing my late father.');
    expect(carried.severity).toBe('warning');
  });

  test('an assignee who is not an active user counts as unset', async () => {
    W = world({ settings: { consent_task_user_id: '9' } });
    await prefs({ action: 'all', note: 'x' });
    expect(createTask).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][1].kind).toBe('consent_task_unassigned');
  });

  test('a note longer than 1000 characters is kept to 1000, never refused (the unsubscribe still records)', async () => {
    const res = await prefs({ action: 'all', note: 'n'.repeat(1500) });
    expect(res.status).toBe(200);
    expect(consentEvents()[0].evidence.note).toHaveLength(1000);
    expect(consentEvents()[0].evidence.note_truncated).toBe(true);
    const arg = createTask.mock.calls[0][1];
    expect(arg.desc.length).toBeLessThanOrEqual(1000);
    expect(arg.log_extra.consent_note).toHaveLength(1000);
  });

  test('a createTask failure never fails the request (post-commit, isolated) and raises a warning', async () => {
    createTask.mockImplementationOnce(async () => { throw new Error('task insert failed'); });
    const res = await prefs({ action: 'all', note: 'hello' });
    expect(res.status).toBe(200);
    expect(stateOf('marketing')).toBe('opted_out');
    expect(alert.mock.calls.map((c) => c[1].kind)).toEqual(['consent_note_task_failed']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('limiters', () => {
  test('READ LIMITER: 30 GETs per minute per IP; the 31st is 429 (headers kept) and touches no DB', async () => {
    for (let i = 0; i < 30; i++) expect((await get(`/u/${TOK}`)).status).toBe(200);
    const before = W.log.length;
    const res = await get(`/u/${TOK}`);
    expect(res.status).toBe(429);
    expectHeaders(res);
    expect(W.log.length).toBe(before);
  });

  test('PREFS LIMITER: 10 form POSTs per minute per IP; the 11th is 429 and touches no DB', async () => {
    for (let i = 0; i < 10; i++) expect((await prefs({ action: 'prefs', t_newsletter: '1', t_events: '1' })).status).toBe(200);
    const before = W.log.length;
    const res = await prefs({ action: 'all' });
    expect(res.status).toBe(429);
    expectHeaders(res);
    expect(W.log.length).toBe(before);
    expect(stateOf('marketing')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the source itself', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'unsubActions.js'), 'utf8')
    .replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  test('no redirect anywhere on /u/ and no body parser re-mounted for it', () => {
    expect(src).not.toMatch(/\.redirect\(/);
    expect(src).not.toMatch(/express\.(json|urlencoded|raw|text)\(/);
    expect(src).not.toMatch(/multer|multipartBody/);
  });
});
