'use strict';
/**
 * tests/ingestRulePreview.routes.test.js
 *
 * A20.1 extracted the core of the four native dry-run endpoints
 *   POST /api/{email,phone}-ingest/rules/test-match
 *   POST /api/{email,phone}-ingest/rules/test-transform
 * into services/ingestRulePreviewService.js, shared with Casey's
 * automation.preview_ingest_rule kind. The routes' responses must be
 * UNCHANGED, so this suite pins them byte-for-byte against a GOLDEN file
 * recorded from the routes as they stood BEFORE the extraction
 * (tests/fixtures/ingestRuleTestRoutes.golden.json, written with
 * GOLDEN_WRITE=1 on the pre-extraction commit). Every case records the HTTP
 * status, the JSON body AND the SQL each request issued (statement shape +
 * params), so a changed query, clamp, error text or ordering fails here.
 *
 * Harness: the REAL routers, real rule/sample services and real dispatcher
 * helpers on an in-process express app. Only the auth middleware is stubbed
 * (a pass-through — auth is not what is under test) and req.db is a scripted
 * stub answering the sample-service fetchers' queries.
 */

process.env.EMAIL_DOMAINS = '4lsg.com';

jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => {
  req.auth = { type: 'jwt', userId: 1, username: 'golden', roles: ['staff'] };
  next();
});

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const GOLDEN = path.join(__dirname, 'fixtures', 'ingestRuleTestRoutes.golden.json');

const TS = new Date('2026-10-20T14:05:00Z');
const INTACT = {
  kind: 'email', source: 'gmail-firm',
  from: { email: 'ecf@mieb.uscourts.gov', name: 'MIEB' },
  to: [{ email: 'docs@4lsg.com', name: '' }],
  subject: 'Notice of Hearing 26-40001',
  headers: { message_id: 'm-101', list_id: null },
  text: 'A hearing is set for 11/3.',
};
const TRUNCATED = { preview: '{"kind":"email"…', _truncated: true, _original_size: 40000 };

function emailExecRow(id) {
  if (id === 101) {
    return { exec_id: 101, created_at: TS, status: 'logged', raw_input: INTACT, el_id: 9001,
      from_email: 'ecf@mieb.uscourts.gov', to_email: 'docs@4lsg.com', subject: 'Notice of Hearing 26-40001',
      body: 'A hearing is set for 11/3.', el_source: 'gmail-firm', el_mid: 'm-101',
      log_extra: { source: 'gmail-firm', message_id: 'm-101', auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } } };
  }
  if (id === 102) {
    return { exec_id: 102, created_at: TS, status: 'skipped_suppression', raw_input: TRUNCATED, el_id: 9002,
      from_email: 'news@vendor.example', to_email: 'stuart@4lsg.com', subject: 'Weekly digest',
      body: 'digest body', el_source: 'gmail-firm', el_mid: 'm-102', log_extra: null };
  }
  if (id === 103) {
    return { exec_id: 103, created_at: TS, status: 'validation_failed', raw_input: null, el_id: null,
      from_email: null, to_email: null, subject: null, body: null, el_source: null, el_mid: null, log_extra: null };
  }
  return null;
}

function phoneExecRow(id) {
  if (id === 201) {
    return { exec_id: 201, created_at: TS, status: 'logged', event_type: 'sms',
      raw_input: { type: 'sms', from: '2485550100', to: '3135550199', message: 'Is my hearing still on?',
        extra: { firmToFirm: false }, data: {} } };
  }
  if (id === 202) {
    return { exec_id: 202, created_at: TS, status: 'logged', event_type: 'call', raw_input: '{not json' };
  }
  if (id === 203) {
    return { exec_id: 203, created_at: TS, status: 'suppressed', event_type: 'call',
      raw_input: { type: 'call', from: '3135550199', to: '2485550100', data: { duration_seconds: 42 }, extra: { firmToFirm: true } } };
  }
  return null;
}

function scriptedDb() {
  const seen = [];
  return {
    seen,
    query: async (sql, params = []) => {
      seen.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      const s = String(sql);
      if (/COUNT\(\*\) AS n/.test(s)) return [[{ n: 7 }]];
      if (/FROM email_ingest_executions eie/.test(s) && /WHERE eie\.id = \?/.test(s)) {
        const r = emailExecRow(Number(params[0]));
        return [r ? [r] : []];
      }
      if (/FROM email_ingest_executions eie/.test(s)) return [[emailExecRow(101), emailExecRow(102)]];
      if (/FROM phone_ingest_executions e/.test(s) && /WHERE e\.id = \?/.test(s)) {
        const r = phoneExecRow(Number(params[0]));
        return [r ? [r] : []];
      }
      if (/FROM phone_ingest_executions e/.test(s)) return [[phoneExecRow(201), phoneExecRow(202), phoneExecRow(203)]];
      throw new Error(`unscripted SQL: ${s}`);
    },
  };
}

const COND_SUBJECT = { operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'Hearing' }] };
const COND_PHONE = { operator: 'and', conditions: [{ path: 'type', op: 'equals', value: 'sms' }] };
// `body` is derived by evaluateRules at ingest, not carried on the wire — the
// golden records what the native tester does with it today, whatever that is.
const COND_BODY = { operator: 'or', conditions: [{ path: 'body', op: 'contains', value: 'hearing' }, { path: 'body', op: 'contains', value: 'digest' }] };

// [name, body] per endpoint; each runs on both channels (phone variants swap
// the condition tree where it matters).
const MATCH_CASES = [
  ['no mode', {}],
  ['bad mode', { match_mode: 'regex', match_config: {} }],
  ['conditions null config', { match_mode: 'conditions' }],
  ['conditions array config', { match_mode: 'conditions', match_config: [] }],
  ['limit zero', { match_mode: 'conditions', match_config: COND_SUBJECT, limit: 0 }],
  ['limit fraction', { match_mode: 'conditions', match_config: COND_SUBJECT, limit: 2.5 }],
  ['limit clamped', { match_mode: 'conditions', match_config: COND_SUBJECT, limit: 900 }],
  ['bad since', { match_mode: 'conditions', match_config: COND_SUBJECT, since: 'not a date' }],
  ['bad until', { match_mode: 'conditions', match_config: COND_SUBJECT, until: 'nope' }],
  ['backwards range', { match_mode: 'conditions', match_config: COND_SUBJECT, since: '2026-10-20', until: '2026-10-01' }],
  ['exec zero', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 0 }],
  ['exec plus since', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 101, since: '2026-10-01' }],
  ['code non-json string', { match_mode: 'code', match_config: 'return true' }],
  ['code empty', { match_mode: 'code', match_config: { code: '   ' } }],
  ['code no compile', { match_mode: 'code', match_config: { code: 'return (' } }],
  ['window default', { match_mode: 'conditions', match_config: COND_SUBJECT }],
  ['window with misses', { match_mode: 'conditions', match_config: COND_SUBJECT, include_misses: true }],
  ['phone-shaped window with misses', { match_mode: 'conditions', match_config: COND_PHONE, include_misses: true }],
  ['since window', { match_mode: 'conditions', match_config: COND_SUBJECT, since: '2026-10-01', include_misses: true }],
  ['until window', { match_mode: 'conditions', match_config: COND_SUBJECT, until: '2026-10-25T00:00:00Z', limit: 5 }],
  ['exec 101', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 101, include_misses: true }],
  ['exec 102', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 102, include_misses: true }],
  ['exec 103', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 103 }],
  ['exec 201', { match_mode: 'conditions', match_config: COND_PHONE, exec_id: 201, include_misses: true }],
  ['exec 202', { match_mode: 'conditions', match_config: COND_PHONE, exec_id: 202 }],
  ['exec missing', { match_mode: 'conditions', match_config: COND_SUBJECT, exec_id: 404 }],
  ['body condition window', { match_mode: 'conditions', match_config: COND_BODY, include_misses: true }],
  ['code window', { match_mode: 'code', match_config: { code: 'return !!(input.subject || input.message);' }, include_misses: true }],
  ['code json string', { match_mode: 'code', match_config: JSON.stringify({ code: 'return true;' }) }],
  ['code throws at runtime', { match_mode: 'code', match_config: { code: 'throw new Error("boom")' }, include_misses: true }],
];

const MAPPER = [{ from: 'subject', to: 'title' }, { from: 'message', to: 'text' }];
const TRANSFORM_CASES = [
  ['no mode', {}],
  ['neither source', { transform_mode: 'passthrough' }],
  ['both sources', { transform_mode: 'passthrough', exec_id: 101, input: {} }],
  ['exec zero', { transform_mode: 'passthrough', exec_id: 0 }],
  ['input array', { transform_mode: 'passthrough', input: [1] }],
  ['input scalar', { transform_mode: 'passthrough', input: 'x' }],
  ['mappings not array', { transform_mode: 'passthrough', input: {}, params_mappings: {} }],
  ['mappings too many', { transform_mode: 'passthrough', input: {}, params_mappings: Array.from({ length: 21 }, () => ({ mapping: {} })) }],
  ['mapping entry bad', { transform_mode: 'passthrough', input: {}, params_mappings: [{ label: 'x' }] }],
  ['passthrough inline', { transform_mode: 'passthrough', input: { subject: 'S', n: 1 } }],
  ['mapper inline + mappings', { transform_mode: 'mapper', transform_config: MAPPER,
    input: { subject: 'Hearing', message: 'hello' },
    params_mappings: [{ label: 'court', mapping: { title: 'title', all: '$', fixed: "'lit'" } }, { mapping: { t: 'text' } }] }],
  ['mapper not array', { transform_mode: 'mapper', transform_config: { from: 'a' }, input: {} }],
  ['mapper string config', { transform_mode: 'mapper', transform_config: JSON.stringify(MAPPER), input: { subject: 'x' } }],
  ['mapper bad json string', { transform_mode: 'mapper', transform_config: '{nope', input: {} }],
  ['code ok', { transform_mode: 'code', transform_config: { code: 'return { s: input.subject || input.message || null };' }, input: { subject: 'S' } }],
  ['code returns scalar', { transform_mode: 'code', transform_config: { code: 'return 5;' }, input: {} }],
  ['code empty', { transform_mode: 'code', transform_config: { code: '' }, input: {} }],
  ['code throws', { transform_mode: 'code', transform_config: { code: 'throw new Error("nope")' }, input: {} }],
  ['unknown mode', { transform_mode: 'xslt', input: {} }],
  ['exec 101', { transform_mode: 'passthrough', exec_id: 101 }],
  ['exec 102 mapper', { transform_mode: 'mapper', transform_config: MAPPER, exec_id: 102, params_mappings: [{ mapping: { t: 'title' } }] }],
  ['exec 103', { transform_mode: 'passthrough', exec_id: 103 }],
  ['exec 201', { transform_mode: 'mapper', transform_config: MAPPER, exec_id: 201 }],
  ['exec 202', { transform_mode: 'passthrough', exec_id: 202 }],
  ['exec missing', { transform_mode: 'passthrough', exec_id: 404 }],
  ['mapping skipped on failure', { transform_mode: 'code', transform_config: { code: 'throw 1' }, input: {}, params_mappings: [{ mapping: { a: 'b' } }] }],
];

function appFor(router, db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(router);
  return app;
}

function post(server, url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) { json = { __raw: raw }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function runAll() {
  const out = {};
  const routers = {
    email: require('../routes/api.emailIngest'),
    phone: require('../routes/api.phoneIngest'),
  };
  for (const channel of ['email', 'phone']) {
    for (const [endpoint, cases] of [['test-match', MATCH_CASES], ['test-transform', TRANSFORM_CASES]]) {
      for (const [name, body] of cases) {
        const db = scriptedDb();
        const server = http.createServer(appFor(routers[channel], db));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        try {
          const res = await post(server, `/api/${channel}-ingest/rules/${endpoint}`, body);
          out[`${channel} ${endpoint} ${name}`] = { status: res.status, body: res.body, queries: db.seen };
        } finally {
          await new Promise((r) => server.close(r));
        }
      }
    }
  }
  return out;
}

describe('native ingest rule dry-run routes are unchanged by the A20.1 extraction (golden)', () => {
  let actual;
  beforeAll(async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    actual = JSON.parse(JSON.stringify(await runAll()));
    if (process.env.GOLDEN_WRITE === '1') {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    }
  });
  afterAll(() => jest.restoreAllMocks());

  test('the matrix covers both channels, both endpoints, every error branch and every source mode', () => {
    expect(Object.keys(actual)).toHaveLength(2 * (MATCH_CASES.length + TRANSFORM_CASES.length));
    const statuses = new Set(Object.values(actual).map((r) => r.status));
    expect([...statuses].sort()).toEqual([200, 400, 404]);
  });

  test('every response and every issued query equals the pre-extraction golden', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
    for (const key of Object.keys(golden)) {
      expect({ key, ...actual[key] }).toEqual({ key, ...golden[key] });
    }
  });
});
