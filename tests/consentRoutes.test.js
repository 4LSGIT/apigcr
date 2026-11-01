// tests/consentRoutes.test.js
//
// YisraMail P4 — the staff consent routes (routes/api.consent.js) and the
// optoutService read helpers they sit on, against an in-memory world
// (tests/helpers/contactConsentWorld + optoutFake answer the statements by
// identity). tests/consentReads.mysql.test.js holds the same reads, the import
// and the preview to a real engine.
//
//   gates        history / export / preview: jwtOrApiKey (anon 401, a scoped key
//                outside its route scopes 403); import: superuserOnlyFor —
//                anon 401, staff 403, API key 403, SU without elevation 401
//                elevation_required, SU + elevation 200 (audited)
//   400s         channel / destination normalization
//   CSV          every field quoted; ", \" and newline survive; a leading
//                = + - @ (and tab) is neutralized — formula injection
//   redaction    the history evidence is an allow-list (token, user_agent … out)
//   import       opt-in 422, bad scope 400, any invalid row 400 with nothing
//                written, > 5000 rows 400, recorded / unchanged counts, a second
//                run records nothing
//   preview      asks findOptedOut exactly what campaignService.executeSend asks
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'consent-routes-test-secret';

const express = require('express');
const jwt = require('jsonwebtoken');

const optout = require('../services/optoutService');
const { _resetRateLimits, mintElevationToken } = require('../lib/auth.superuser');
const { makeWorld } = require('./helpers/contactConsentWorld');
const consentRoute = require('../routes/api.consent');

const PAT = '3135550001';
const SAM = '3135550002';
const T = (s) => new Date(s);

const SCOPED_KEY = 'consent-routes-scoped-test-key';   // a fake: answered by the db stub below

let W;            // the world the current test reads
let auditRows;    // admin_audit_log params
let failOn;       // (sql, params) => Error | null — a test injects a DB failure
let server;
let base;

function connFor(query) {
  return { query, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}, destroy() {} };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, _res, next) => {
    const query = async (sql, p) => {
      const boom = failOn && failOn(sql, p);
      if (boom) throw boom;
      if (/INSERT INTO jwt_api_audit_log/.test(sql)) return [{ insertId: 1 }];
      if (/INSERT INTO admin_audit_log/.test(sql)) { auditRows.push(p); return [{ insertId: 1 }]; }
      if (/FROM api_keys WHERE key_hash/.test(sql)) return [[{ id: 9, label: 'scoped', revoked_at: null, expires_at: null, scopes: JSON.stringify(['route:/api/campaigns']) }]];
      if (/UPDATE api_keys SET last_used_at/.test(sql)) return [{ affectedRows: 1 }];
      // The preview's contact read (the world models contacts by id only).
      if (/^SELECT contact_id, contact_phone, contact_email FROM contacts WHERE contact_id IN \(\?\)$/.test(sql)) {
        const ids = new Set(p[0].map(Number));
        return [W.contacts.filter((c) => ids.has(c.contact_id)).map((c) => ({ contact_id: c.contact_id, contact_phone: c.contact_phone, contact_email: c.contact_email }))];
      }
      // The import's row lock (routes/api.consent.js ACTIVE_ROW_SQL) — the world answers the rest.
      const m = /^SELECT id, contact_id FROM (contact_phones|contact_emails) WHERE (?:phone|email)_active_uniq = \? FOR UPDATE$/.exec(sql);
      if (m) {
        const r = W.active(m[1], p[0]);
        return [r ? [{ id: r.id, contact_id: r.contact_id }] : []];
      }
      return W.db.query(sql, p);
    };
    req.db = { query, getConnection: async () => connFor(query) };
    next();
  });
  app.use(consentRoute);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(r); }));
beforeEach(() => {
  _resetRateLimits();
  auditRows = [];
  failOn = null;
  delete process.env.SU_STEPUP;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const staff = (over = {}) => jwt.sign({ sub: '22', username: 'rena', user_auth: 'authorized', roles: [], aud: 'staff', ...over }, process.env.JWT_SECRET);
const su = () => staff({ sub: '6', username: 'fred', roles: ['su'] });

async function call(method, p, { bearer, key, elev, body } = {}) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(key ? { 'x-api-key': key } : {}),
      ...(elev ? { 'x-su-elevation': elev } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* csv */ }
  return { status: r.status, headers: r.headers, text, json };
}

function ledgerWorld() {
  W = makeWorld({
    contacts: [{ contact_id: 1, contact_name: 'Pat One', contact_phone: PAT, contact_email: 'pat@example.com' },
      { contact_id: 2, contact_name: 'Sam Two', contact_phone: SAM, contact_email: 'sam@example.com' }],
    phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1 }, { id: 12, contact_id: 2, phone: SAM, sms_optout: 0 }],
    emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 1 }, { id: 22, contact_id: 2, email: 'sam@example.com', email_optout: 0 }],
    states: [
      { channel: 'sms', destination: PAT, scope: 'all', state: 'opted_out', occurred_at: T('2026-10-30T12:00:00Z'), last_event_id: 2 },
      { channel: 'email', destination: 'pat@example.com', scope: 'marketing', state: 'opted_out', occurred_at: T('2026-10-29T12:00:00Z'), last_event_id: 3 },
      { channel: 'email', destination: 'pat@example.com', scope: 'newsletter', state: 'opted_out', occurred_at: T('2026-10-28T12:00:00Z'), last_event_id: 4 },
    ],
    topics: [{ topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 1, label: 'Newsletter' }],
  });
  W.events.push(
    { id: 1, channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'sms_keyword', occurred_at: T('2026-10-29T08:00:00Z'),
      contact_id: 1, line_number: '2484179800', send_ref: null, actor_user_id: null,
      evidence: { keyword: 'STOP', body: `STOP ${'x'.repeat(400)}`, provider: 'quo', provider_ref: 'AC123' } },
    { id: 2, channel: 'sms', destination: PAT, scope: 'all', action: 'opt_out', source: 'staff', occurred_at: T('2026-10-30T12:00:00Z'),
      contact_id: 1, line_number: null, send_ref: null, actor_user_id: 6, evidence: { row_id: 11, via: 'aggregate', note: 'asked by phone' } },
    { id: 3, channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'unsub_page',
      occurred_at: T('2026-10-29T12:00:00Z'), contact_id: 1, line_number: null, send_ref: '77', actor_user_id: null,
      evidence: { token: 'AbCdEfGhIjKlMnOpQrStUv', via: 'unsub_page', ip: '203.0.113.9', user_agent: 'Mozilla/5.0', campaign_id: 4, note: '=HYPERLINK("http://x")' } },
    { id: 4, channel: 'email', destination: 'pat@example.com', scope: 'newsletter', action: 'opt_out', source: 'one_click',
      occurred_at: T('2026-10-28T12:00:00Z'), contact_id: 1, line_number: null, send_ref: null, actor_user_id: null,
      evidence: { token: 'ZzZzZzZzZzZzZzZzZzZzZz', via: 'rfc8058', note: 'line one\nline "two", +1' } },
  );
  return W;
}
// The history read's actor join: the world has no users table — answer it here.
function withUsers(world) {
  const inner = world.db.query;
  world.db.query = async (sql, p) => {
    const r = await inner(sql, p);
    if (sql === optout.FIND_SQL.history) for (const row of r[0]) if (row.actor_user_id === 6) row.actor_name = 'Fred';
    return r;
  };
  return world;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('optoutService read helpers', () => {
  test('consentSummary: every scope with a state row, its source, topic label; {} for a destination with none', async () => {
    const w = ledgerWorld();
    const sms = await optout.consentSummary(w.db, 'sms', [PAT, SAM]);
    expect(sms.get(PAT)).toEqual({ version: '2', scopes: { all: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-30T12:00:00.000Z', source: 'staff' } } });
    expect(sms.get(SAM)).toEqual({ version: '0', scopes: {} });
    const email = await optout.consentSummary(w.db, 'email', ['Pat@Example.com']);
    expect(email.get('pat@example.com').scopes).toEqual({
      marketing: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-29T12:00:00.000Z', source: 'unsub_page' },
      newsletter: { opted_out: true, state: 'opted_out', occurred_at: '2026-10-28T12:00:00.000Z', source: 'one_click', label: 'Newsletter', active: true, consent_model: 'opt_out' },
    });
    expect((await optout.consentSummary(w.db, 'sms', ['555-0001'])).size).toBe(0);   // not a destination: no query, empty
  });

  test('redactEvidence keeps the allow-list only, clips text, drops the token / user_agent / refs', () => {
    expect(optout.redactEvidence({ token: 'AbCdEfGhIjKlMnOpQrStUv', via: 'unsub_page', ip: '203.0.113.9', user_agent: 'UA', campaign_id: 4,
      note: 'n', provider_ref: 'AC1', key_id: 3, key_label: 'zap', row_id: 11, draft_id: 'd', body: 'b'.repeat(250), nested: { a: 1 } }))
      .toEqual({ via: 'unsub_page', ip: '203.0.113.9', campaign_id: 4, note: 'n', key_label: 'zap', body: `${'b'.repeat(200)}…` });
    expect(optout.redactEvidence('{"via":"import","batch_id":"x","token":"t"}')).toEqual({ via: 'import', batch_id: 'x' });
    expect(optout.redactEvidence(null)).toEqual({});
    // Scalars only: an object or an array under an ALLOWED key is dropped (a nested token never leaks).
    expect(optout.redactEvidence({ via: { token: 'AbCdEfGhIjKlMnOpQrStUv' }, note: ['a', 'b'], keyword: { x: 1 }, ip: '198.51.100.7', campaign_id: 4 }))
      .toEqual({ ip: '198.51.100.7', campaign_id: 4 });
    expect(optout.redactEvidence({ note: 'n'.repeat(1200) }).note).toHaveLength(1001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('gates', () => {
  const H = `/api/consent/history?channel=sms&destination=${PAT}`;
  const X = `/api/consent/export?channel=sms&destination=${PAT}`;
  const PV = '/api/consent/preview';
  const IM = '/api/consent/import';
  const importBody = { channel: 'sms', scope: 'all', rows: [{ destination: SAM }], source: 'import' };

  test('anonymous → 401 on all four', async () => {
    withUsers(ledgerWorld());
    expect((await call('GET', H)).status).toBe(401);
    expect((await call('GET', X)).status).toBe(401);
    expect((await call('POST', PV, { body: { channel: 'sms', contact_ids: [1] } })).status).toBe(401);
    expect((await call('POST', IM, { body: importBody })).status).toBe(401);
  });

  test('a scoped API key outside its route scopes → 403 on the read routes; any API key → 403 on the import', async () => {
    withUsers(ledgerWorld());
    expect((await call('GET', H, { key: SCOPED_KEY })).status).toBe(403);
    expect((await call('GET', X, { key: SCOPED_KEY })).status).toBe(403);
    expect((await call('POST', PV, { key: SCOPED_KEY, body: { channel: 'sms', contact_ids: [1] } })).status).toBe(403);
    expect((await call('POST', IM, { key: SCOPED_KEY, body: importBody })).status).toBe(403);
  });

  test('staff JWT: reads 200; the import 403 (not SU), audited', async () => {
    withUsers(ledgerWorld());
    expect((await call('GET', H, { bearer: staff() })).status).toBe(200);
    expect((await call('GET', X, { bearer: staff() })).status).toBe(200);
    expect((await call('POST', PV, { bearer: staff(), body: { channel: 'sms', contact_ids: [1] } })).status).toBe(200);
    const r = await call('POST', IM, { bearer: staff(), body: importBody });
    expect(r.status).toBe(403);
    expect(auditRows.map((p) => [p[0], p[5]])).toEqual([['consent_import', 'rejected_not_su']]);
    expect(W.events).toHaveLength(4);
  });

  test('SU without elevation → 401 elevation_required (nothing written); with it → 200, audited success', async () => {
    withUsers(ledgerWorld());
    const r1 = await call('POST', IM, { bearer: su(), body: importBody });
    expect(r1.status).toBe(401);
    expect(r1.json.code).toBe('elevation_required');
    expect(W.events).toHaveLength(4);
    const r2 = await call('POST', IM, { bearer: su(), elev: mintElevationToken(6), body: importBody });
    expect(r2.status).toBe(200);
    expect(r2.json).toMatchObject({ status: 'success', recorded: 1, unchanged: 0, invalid: 0, duplicates: 0 });
    const last = auditRows[auditRows.length - 1];
    expect([last[0], last[5]]).toEqual(['consent_import', 'success']);
    expect(JSON.parse(last[10])).toMatchObject({ channel: 'sms', scope: 'all', rows: 1, recorded: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('history / export', () => {
  test('destination normalization: a bad channel or destination is a 400; a formatted number is normalized', async () => {
    withUsers(ledgerWorld());
    expect((await call('GET', `/api/consent/history?channel=fax&destination=${PAT}`, { bearer: staff() })).json.code).toBe('bad_channel');
    expect((await call('GET', '/api/consent/history?channel=sms&destination=555-0001', { bearer: staff() })).json.code).toBe('bad_destination');
    expect((await call('GET', '/api/consent/history?channel=email&destination=not-an-address', { bearer: staff() })).status).toBe(400);
    expect((await call('GET', '/api/consent/history?channel=sms', { bearer: staff() })).status).toBe(400);
    // One address only: normalizeDestination alone would take "a@x.com,b@y.com" as one string.
    expect((await call('GET', '/api/consent/export?channel=email&destination=a%40x.com%2Cb%40y.com', { bearer: staff() })).status).toBe(400);
    const r = await call('GET', `/api/consent/history?channel=sms&destination=${encodeURIComponent('+1 (313) 555-0001')}`, { bearer: staff() });
    expect(r.status).toBe(200);
    expect(r.json.destination).toBe(PAT);
  });

  test('history: newest first, actor named, evidence redacted (no token, no user_agent, body clipped)', async () => {
    withUsers(ledgerWorld());
    const s = await call('GET', `/api/consent/history?channel=sms&destination=${PAT}`, { bearer: staff() });
    expect(s.json.events.map((e) => [e.id, e.source, e.actor])).toEqual([[2, 'staff', 'Fred'], [1, 'sms_keyword', null]]);
    expect(s.json.events[0].evidence).toEqual({ via: 'aggregate', note: 'asked by phone' });
    expect(s.json.events[1].evidence).toEqual({ keyword: 'STOP', body: `STOP ${'x'.repeat(195)}…`, provider: 'quo' });
    expect(s.json.events[1]).toMatchObject({ line_number: '2484179800', occurred_at: '2026-10-29T08:00:00.000Z' });
    const e = await call('GET', '/api/consent/history?channel=email&destination=Pat%40Example.com', { bearer: staff() });
    expect(e.json.events.map((x) => x.id)).toEqual([3, 4]);
    expect(JSON.stringify(e.json)).not.toMatch(/AbCdEfGhIjKlMnOpQrStUv|ZzZzZzZz|Mozilla/);
    expect(e.json.events[0].evidence).toEqual({ via: 'unsub_page', ip: '203.0.113.9', campaign_id: 4, note: '=HYPERLINK("http://x")' });
    // An object / array under an allowed key never reaches the reader.
    W.events.push({ id: 5, channel: 'email', destination: 'pat@example.com', scope: 'marketing', action: 'opt_out', source: 'staff',
      occurred_at: T('2026-10-31T00:00:00Z'), contact_id: 1, actor_user_id: null,
      evidence: { via: { token: 'NeStEdToKeNnEsTeDtOkEn' }, note: ['x'], ip: '198.51.100.7' } });
    const n = await call('GET', '/api/consent/history?channel=email&destination=pat%40example.com', { bearer: staff() });
    expect(n.json.events[0]).toMatchObject({ id: 5, evidence: { ip: '198.51.100.7' } });
    expect(Object.keys(n.json.events[0].evidence)).toEqual(['ip']);
    expect(n.text).not.toContain('NeStEdToKeN');
  });

  test('export: an attachment CSV of the same rows; every field quoted; formula injection neutralized', async () => {
    withUsers(ledgerWorld());
    const r = await call('GET', '/api/consent/export?channel=email&destination=pat%40example.com', { bearer: staff() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="consent-email-pat_example.com.csv"');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.text).not.toMatch(/AbCdEfGhIjKlMnOpQrStUv|<html/i);
    const lines = r.text.split('\r\n');
    expect(lines[0]).toBe('"event_id","occurred_at_utc","channel","destination","scope","action","source","actor","actor_user_id","contact_id","line_number","send_ref","evidence"');
    expect(lines[1].startsWith('"3","2026-10-29T12:00:00.000Z","email","pat@example.com","marketing","opt_out","unsub_page","","","1","","77",')).toBe(true);
    // The evidence JSON is one quoted field: inner quotes doubled.
    expect(lines[1]).toContain('"{""via"":""unsub_page"",""note"":""=HYPERLINK(\\""http://x\\"")""');
    // A note with a newline, a quote and a comma stays inside its quoted field (the row spans two physical lines).
    expect(r.text).toContain('line one\\nline \\""two\\"", +1');
  });

  test('csvCell: always quoted; quotes doubled; comma / newline kept inside; a leading = + - @ tab neutralized', () => {
    const c = consentRoute.csvCell;
    expect(c('plain')).toBe('"plain"');
    expect(c('a,b')).toBe('"a,b"');
    expect(c('say "hi"')).toBe('"say ""hi"""');
    expect(c('line1\nline2')).toBe('"line1\nline2"');
    expect(c('=SUM(A1:A2)')).toBe('"\'=SUM(A1:A2)"');
    expect(c('+15551234567')).toBe('"\'+15551234567"');
    expect(c('-2+3')).toBe('"\'-2+3"');
    expect(c('@cmd')).toBe('"\'@cmd"');
    expect(c('\t=1')).toBe('"\'\t=1"');
    expect(c(null)).toBe('""');
    expect(c(42)).toBe('"42"');
    expect(c({ a: '=1' })).toBe('"{""a"":""=1""}"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('import (SU)', () => {
  const elev = () => mintElevationToken(6);
  const imp = (body) => call('POST', '/api/consent/import', { bearer: su(), elev: elev(), body });

  test('an opt-in is refused 422 — by body action or by any row — and nothing is written', async () => {
    withUsers(ledgerWorld());
    const a = await imp({ channel: 'sms', scope: 'all', action: 'opt_in', rows: [{ destination: SAM }], source: 'import' });
    expect([a.status, a.json.code]).toEqual([422, 'import_opt_out_only']);
    const b = await imp({ channel: 'sms', scope: 'all', rows: [{ destination: SAM }, { destination: PAT, action: 'opt_in' }], source: 'import' });
    expect([b.status, b.json.code]).toEqual([422, 'import_opt_out_only']);
    expect(W.events).toHaveLength(4);
  });

  test('the scope must pass assertScope: email "all", SMS "marketing", an unknown topic → 400', async () => {
    withUsers(ledgerWorld());
    for (const [channel, scope] of [['email', 'all'], ['sms', 'marketing'], ['email', 'events'], ['sms', 'newsletter'], ['email', 'Bad Scope']]) {
      const r = await imp({ channel, scope, rows: [{ destination: channel === 'sms' ? SAM : 'sam@example.com' }], source: 'import' });
      expect([channel, scope, r.status, r.json.code]).toEqual([channel, scope, 400, 'bad_scope']);
    }
    expect(W.events).toHaveLength(4);
  });

  test('all-or-nothing validation: one bad row → 400 invalid_rows listing it, NOTHING recorded', async () => {
    withUsers(ledgerWorld());
    const r = await imp({ channel: 'email', scope: 'marketing', source: 'import',
      rows: [{ destination: 'sam@example.com' }, { destination: 'nope' }, { destination: 'x@y.org', note: 'n'.repeat(1001) }] });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ code: 'invalid_rows', recorded: 0, unchanged: 0, invalid: 2 });
    expect(r.json.invalid_rows).toEqual([{ index: 1, destination: 'nope', reason: 'destination' }, { index: 2, destination: 'x@y.org', reason: 'note_too_long' }]);
    expect(W.events).toHaveLength(4);
  });

  test('shape: no rows, > 5000 rows, a bad channel or a non-import source → 400', async () => {
    withUsers(ledgerWorld());
    expect((await imp({ channel: 'sms', scope: 'all', rows: [] })).json.code).toBe('bad_rows');
    const many = Array.from({ length: 5001 }, (_, i) => ({ destination: `31355${String(i).padStart(5, '0')}` }));
    expect((await imp({ channel: 'sms', scope: 'all', rows: many })).json.code).toBe('bad_rows');
    expect((await imp({ channel: 'fax', scope: 'all', rows: [{ destination: SAM }] })).json.code).toBe('bad_channel');
    expect((await imp({ channel: 'sms', scope: 'all', rows: [{ destination: SAM }], source: 'staff' })).json.code).toBe('bad_source');
    expect(W.events).toHaveLength(4);
  });

  test('records one opt_out per new destination (source import, evidence via/batch_id/note, the SU as actor); unchanged for one already out; a second run records nothing', async () => {
    withUsers(ledgerWorld());
    const body = { channel: 'sms', scope: 'all', source: 'import',
      rows: [{ destination: PAT }, { destination: '(313) 555-0002', note: 'from the old list' }, { destination: '3135550007' }, { destination: SAM }] };
    const r = await imp(body);
    expect(r.json).toMatchObject({ status: 'success', recorded: 2, unchanged: 1, invalid: 0, duplicates: 1 });
    const added = W.events.slice(4);
    expect(added.map((e) => [e.destination, e.scope, e.action, e.source, e.actor_user_id, e.contact_id])).toEqual([
      [SAM, 'all', 'opt_out', 'import', 6, 2], ['3135550007', 'all', 'opt_out', 'import', 6, null]]);
    expect(added[0].evidence).toEqual({ via: 'import', batch_id: r.json.batch_id, note: 'from the old list' });
    expect(added[1].evidence).toEqual({ via: 'import', batch_id: r.json.batch_id });
    expect(W.phone(12).sms_optout).toBe(1);                                // recordConsent's cache sync
    const again = await imp(body);
    expect(again.json).toMatchObject({ recorded: 0, unchanged: 3, duplicates: 1 });
    expect(W.events).toHaveLength(6);
  });

  test('the success answer says when duplicate rows were collapsed (and only then)', async () => {
    withUsers(ledgerWorld());
    const one = await imp({ channel: 'sms', scope: 'all', rows: [{ destination: '3135550011' }] });
    expect(one.json.message).toBeUndefined();
    const dup = await imp({ channel: 'sms', scope: 'all', rows: [{ destination: '3135550012' }, { destination: '(313) 555-0012' }, { destination: '313.555.0012' }] });
    expect(dup.json).toMatchObject({ recorded: 1, duplicates: 2 });
    expect(dup.json.message).toMatch(/^2 duplicate rows in the file collapsed/);
  });

  test('a refused import is audited "rejected" with its code; nothing written', async () => {
    withUsers(ledgerWorld());
    const r = await imp({ channel: 'email', scope: 'all', rows: [{ destination: 'sam@example.com' }] });
    expect(r.status).toBe(400);
    const rows = auditRows.filter((p) => p[0] === 'consent_import');
    expect(rows.map((p) => [p[5], p[6]])).toEqual([['rejected', expect.stringMatching(/scope "all" exists for SMS only/)]]);
    expect(JSON.parse(rows[0][10])).toEqual({ code: 'bad_scope' });
    const v = await imp({ channel: 'sms', scope: 'all', rows: [{ destination: 'x' }, { destination: SAM }] });
    expect(v.status).toBe(400);
    const last = auditRows[auditRows.length - 1];
    expect([last[0], last[5], JSON.parse(last[10])]).toEqual(['consent_import', 'rejected', { code: 'invalid_rows', invalid: 1 }]);
    expect(W.events).toHaveLength(4);
  });

  test('a failure part-way: one transaction per destination, so the earlier ones stay committed; the 500 and the "error" audit carry the counts', async () => {
    withUsers(ledgerWorld());
    failOn = (sql, p) => (sql === optout.WRITE_SQL.event && p[1] === '3135550008' ? new Error('disk on fire') : null);
    const r = await imp({ channel: 'sms', scope: 'all', rows: [{ destination: SAM }, { destination: PAT }, { destination: '3135550008' }, { destination: '3135550007' }] });
    expect(r.status).toBe(500);
    expect(r.json.committed).toMatchObject({ recorded: 1, unchanged: 1 });
    expect(r.json.message).toMatch(/counts below were committed/);
    expect(W.events.slice(4).map((e) => e.destination)).toEqual([SAM]);   // 0007 never reached
    const last = auditRows[auditRows.length - 1];
    expect([last[0], last[5], last[6]]).toEqual(['consent_import', 'error', 'disk on fire']);
    expect(JSON.parse(last[10]).partial).toMatchObject({ recorded: 1, unchanged: 1, batch_id: r.json.committed.batch_id });
  });

  test('a failure before any write (the scope lookup): 500 says nothing was recorded — no "counts below" — and is audited "error" with no partial', async () => {
    withUsers(ledgerWorld());
    failOn = (sql) => (sql === optout.FIND_SQL.topic ? new Error('db away') : null);
    const r = await imp({ channel: 'email', scope: 'newsletter', rows: [{ destination: 'sam@example.com' }] });
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ status: 'error', message: 'Import failed before anything was recorded.' });
    const last = auditRows[auditRows.length - 1];
    expect([last[0], last[5], last[6], JSON.parse(last[10])]).toEqual(['consent_import', 'error', 'db away', { partial: null }]);
    expect(W.events).toHaveLength(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('preview (campaign compose)', () => {
  test('counts: skipped for consent, missing a destination, not found; email asks as marketing (D18 has no effect on a campaign until C1)', async () => {
    const w = withUsers(ledgerWorld());
    w.contacts.push({ contact_id: 3, contact_name: 'No Phone', contact_phone: '', contact_email: '' });
    const pv = (body) => call('POST', '/api/consent/preview', { bearer: staff(), body });
    expect((await pv({ channel: 'sms', contact_ids: [1, 2, 3, 99, 2] })).json).toEqual({ status: 'success', channel: 'sms', selected: 4,
      will_send: 1, skipped_optout: 1, missing_destination: 1, not_found: 1 });
    expect((await pv({ channel: 'email', contact_ids: [1, 2] })).json).toMatchObject({ skipped_optout: 1, will_send: 1 });
    expect((await pv({ channel: 'email', contact_ids: [] })).json).toMatchObject({ selected: 0, skipped_optout: 0 });
    expect((await pv({ channel: 'fax', contact_ids: [1] })).status).toBe(400);
    expect((await pv({ channel: 'sms', contact_ids: ['x'] })).status).toBe(400);
    expect((await pv({ channel: 'sms', contact_ids: Array.from({ length: 5001 }, (_, i) => i + 1) })).status).toBe(400);
  });

  test('reads the consent STATE, not only the row flag: a state opt-out with a clear row flag is skipped', async () => {
    const w = withUsers(ledgerWorld());
    w.states.push({ channel: 'sms', destination: SAM, scope: 'all', state: 'opted_out', occurred_at: T('2026-10-31T00:00:00Z'), last_event_id: 9 });
    expect(w.phone(12).sms_optout).toBe(0);
    const r = await call('POST', '/api/consent/preview', { bearer: staff(), body: { channel: 'sms', contact_ids: [2] } });
    expect(r.json).toMatchObject({ skipped_optout: 1, will_send: 0 });
  });

  test('asks findOptedOut what campaignService.executeSend asks, per channel (same channel, same opts, same destination)', async () => {
    const campaignService = require('../services/campaignService');
    for (const type of ['sms', 'email']) {
      const spy = jest.spyOn(optout, 'findOptedOut').mockResolvedValue([{ destination: 'x' }]);
      const db = {
        query: async (sql) => {
          if (/FROM campaigns WHERE campaign_id/.test(sql)) return [[{ campaign_id: 5, type, sender: 's', subject: 'x', body: 'b', status: 'pending' }]];
          if (/FROM contacts WHERE contact_id = \?/.test(sql)) return [[{ contact_id: 1, contact_name: 'Pat', contact_phone: PAT, contact_email: 'pat@example.com' }]];
          if (/FROM contacts WHERE contact_id IN/.test(sql)) return [[{ contact_id: 1, contact_phone: PAT, contact_email: 'pat@example.com' }]];
          if (/^\s*SELECT/i.test(sql)) return [[{ done: 0, total: 2 }]];   // checkCompletion: still in progress
          return [{ affectedRows: 1, insertId: 1 }];
        },
      };
      await campaignService.executeSend(db, 5, 1);
      await consentRoute.previewConsent(db, { channel: type, contact_ids: [1] });
      expect(spy).toHaveBeenCalledTimes(2);
      const [send, preview] = spy.mock.calls;
      expect(preview[1]).toBe(send[1]);                                                   // channel
      expect(preview[3] || {}).toEqual(send[3] || {});                                    // klass / topic
      const keys = type === 'sms' ? optout.phoneKeys : optout.emailKeys;
      expect(keys(preview[2])).toEqual(keys(send[2]));                                    // destination
      spy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the contact form\'s opt-out note (contactService aggregate save → evidence.note)', () => {
  const contactService = require('../services/contactService');
  const STAFF6 = { kind: 'user', userId: 6 };
  const C1 = { contact_id: 1, contact_name: 'Pat One' };

  test('a changed flag carries its note onto the staff event (opt_out and opt_in, phone and email); the three-way compare is untouched', async () => {
    const w = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }],
      emails: [{ id: 21, contact_id: 1, email: 'pat@example.com', email_optout: 0, is_primary: 1 }] });
    await contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, sms_optout_note: '  asked by phone  ' }],
      emails: [{ id: 21, email: 'pat@example.com', email_optout: 1, email_optout_base: 0, email_optout_note: 'said no more newsletters' }] },
    { userId: 6, consentActor: STAFF6 });
    await contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 0, sms_optout_base: 1, sms_optout_note: 'texted START to staff' }] },
      { userId: 6, consentActor: STAFF6 });
    expect(w.events.map((e) => [e.channel, e.action, e.source, e.actor_user_id, e.evidence])).toEqual([
      ['sms', 'opt_out', 'staff', 6, { row_id: 11, via: 'aggregate', note: 'asked by phone' }],
      ['email', 'opt_out', 'staff', 6, { row_id: 21, via: 'aggregate', note: 'said no more newsletters' }],
      ['sms', 'opt_in', 'staff', 6, { row_id: 11, via: 'aggregate', note: 'texted START to staff' }],
    ]);
    expect(w.unhandled).toEqual([]);
  });

  test('a note beside an UNCHANGED flag records nothing; a blank note adds no key; > 1000 characters is a row validation error', async () => {
    const w = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1, label: 'Mobile' }] });
    await contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: PAT, label: 'Work', sms_optout: 0, sms_optout_base: 0, sms_optout_note: 'stray' }] },
      { userId: 6, consentActor: STAFF6 });
    expect(w.events).toEqual([]);
    expect(w.phone(11).label).toBe('Work');
    await contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 1, sms_optout_base: 0, sms_optout_note: '   ' }] },
      { userId: 6, consentActor: STAFF6 });
    expect(w.events.map((e) => e.evidence)).toEqual([{ row_id: 11, via: 'aggregate' }]);
    await expect(contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: PAT, sms_optout: 0, sms_optout_base: 1, sms_optout_note: 'x'.repeat(1001) }] },
      { userId: 6, consentActor: STAFF6 })).rejects.toMatchObject({ errors: { phones: [{ index: 0, field: 'sms_optout_note' }] } });
    expect(w.events).toHaveLength(1);
  });

  test('a correction (new number) with a ticked flag: the note rides the user\'s staff event, never a carried row_replace', async () => {
    const w = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 0, is_primary: 1 }] });
    await contactService.updateContact(w.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout: 1, sms_optout_base: 0, sms_optout_note: 'new number, no texts' }] },
      { userId: 6, consentActor: STAFF6 });
    expect(w.events.map((e) => [e.destination, e.source, e.evidence.note])).toEqual([[SAM, 'staff', 'new number, no texts']]);
    const w2 = makeWorld({ contacts: [C1], phones: [{ id: 11, contact_id: 1, phone: PAT, sms_optout: 1, is_primary: 1 }],
      states: [{ channel: 'sms', destination: PAT, scope: 'all', state: 'opted_out', last_event_id: 1 }] });
    await contactService.updateContact(w2.db, 1, { phones: [{ id: 11, phone: SAM, sms_optout_note: 'typo fix' }] }, { userId: 6, consentActor: STAFF6 });
    expect(w2.events.map((e) => [e.destination, e.source, 'note' in e.evidence])).toEqual([[SAM, 'row_replace', false]]);
  });
});
