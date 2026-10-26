'use strict';
/**
 * tests/ingestCodeGate.routes.test.js
 *
 * Email + phone ingest CODE bodies are gated on automations.manage
 * (lib/ingestCodeGate.js).
 *
 * WHY THIS SUITE EXISTS: ingest rule match/transform code and suppression
 * code ran IN THIS PROCESS via `new Function('input', code)`, where `process`
 * — and process.env, with the DB credentials and JWT_SECRET — was reachable.
 * Every ingest management route was plain jwtOrApiKey, so any staff JWT could
 * save a code rule or POST a code body to test-transform and read back
 * `process.env` in the response. Since 2026-10-26 the bodies run in the
 * QuickJS guest engine in the sandbox child (lib/guestCode.js) and find no
 * `process` (the admin cases assert it), but the gate stays exactly as it
 * was — relaxing it is Fred's call after a soak. A gate on one writer is a
 * gate on none (scheduledJobs.codeGate.test.js), so every code-accepting
 * route is here, both channels.
 *
 * HARNESS: the REAL routers and services on an ephemeral socket. Only
 * jwtOrApiKey is mocked (to set req.auth). req.db is a scripted stub that
 * serves the rows the routes read and RECORDS every statement, so a refusal
 * proves "nothing written" (no INSERT/UPDATE reached the db). "Nothing
 * executed" is proven directly: every input a marked body is run against is
 * counted at the guest engine's one entry point (guestCode.runBodies,
 * observed — the real one still runs), which a refused request must leave at
 * zero and an allowed one must bump. The bodies also bump the global they can
 * see; the HOST global must stay untouched on every path (afterEach).
 */

process.env.EMAIL_DOMAINS = '4lsg.com';

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const http = require('http');
const express = require('express');

const STAFF = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 1, username: 'admin', roles: ['admin', 'staff', 'attorney'] };
const IT    = { type: 'jwt', userId: 6, username: 'it', roles: ['it'] };
const LEGACY_KEY = { type: 'api_key', scopes: null };
const ROUTE_KEY  = { type: 'api_key', scopes: ['route:/mailbox-ingest'] };

const HIT = '__ingestCodeGateHit';
const BUMP = `globalThis.${HIT} = (globalThis.${HIT} || 0) + 1;`;
const MATCH_CODE = { code: `${BUMP} return true;` };
const TRANSFORM_CODE = { code: `${BUMP} return { leaked: typeof process };` };
const COND = { operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'Hearing' }] };
const MAPPER = [{ from: 'subject', to: 'title' }];

const TS = new Date('2026-10-20T14:05:00Z');

const CH = {
  email: {
    rules: 'email_ingest_rules',
    supp: 'email_ingest_log_suppressions',
    execId: 101,
    execRow: {
      exec_id: 101, created_at: TS, status: 'logged',
      raw_input: { kind: 'email', source: 'gmail-firm', from: { email: 'ecf@mieb.uscourts.gov', name: 'MIEB' },
        to: [{ email: 'docs@4lsg.com', name: '' }], subject: 'Notice of Hearing', headers: { message_id: 'm-101' }, text: 'x' },
      el_id: 9001, from_email: 'ecf@mieb.uscourts.gov', to_email: 'docs@4lsg.com', subject: 'Notice of Hearing',
      body: 'x', el_source: 'gmail-firm', el_mid: 'm-101', log_extra: null,
    },
    execRe: /FROM email_ingest_executions eie/,
  },
  phone: {
    rules: 'phone_ingest_rules',
    supp: 'phone_log_suppressions',
    execId: 201,
    execRow: {
      exec_id: 201, created_at: TS, status: 'logged', event_type: 'sms',
      raw_input: { type: 'sms', from: '2485550100', to: '3135550199', message: 'hi', extra: { firmToFirm: false }, data: {} },
    },
    execRe: /FROM phone_ingest_executions e/,
  },
};

// The stored rows the update routes read. A rule whose transform is code (the
// live shape: 8 email rules + 1 phone rule), a code suppression, and their
// non-code twins.
function storedRule(id, ch) {
  const code = id === 1;
  return {
    id, name: code ? 'code rule' : 'cond rule', description: null, active: 1, position: 0,
    match_mode: 'conditions', match_config: COND,
    transform_mode: code ? 'code' : 'mapper', transform_config: code ? { code: 'return input;' } : MAPPER,
    match_count: 0, last_matched_at: null, last_modified_by: 6, created_at: TS, updated_at: TS, _ch: ch,
  };
}
function storedSupp(id) {
  const code = id === 1;
  return {
    id, name: code ? 'code supp' : 'cond supp', description: null, active: 1,
    match_mode: code ? 'code' : 'conditions', match_config: code ? { code: 'return false;' } : COND,
    match_count: 0, last_matched_at: null, last_modified_by: 6, created_at: TS, updated_at: TS,
  };
}

function scriptedDb(chName) {
  const ch = CH[chName];
  const seen = [];
  const db = {
    seen,
    writes: () => seen.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql) && !/admin_audit_log/.test(s.sql)),
    query: async (sql, params = []) => {
      const s = String(sql);
      seen.push({ sql: s, params });
      if (/^\s*INSERT/i.test(s)) return [{ insertId: 1, affectedRows: 1 }];
      if (/^\s*(UPDATE|DELETE)/i.test(s)) return [{ affectedRows: 1 }];
      if (new RegExp(`FROM ${ch.rules} WHERE id = \\?`).test(s.replace(/\s+/g, ' '))) {
        return [[storedRule(Number(params[0]), chName)]];
      }
      if (/_rule_actions/.test(s)) return [[]];
      if (new RegExp(`FROM ${ch.supp}`).test(s) && /WHERE id = \?/.test(s)) return [[storedSupp(Number(params[0]))]];
      if (ch.execRe.test(s)) return [[ch.execRow]];
      if (/COUNT\(\*\) AS n/.test(s)) return [[{ n: 1 }]];
      throw new Error(`unscripted SQL: ${s}`);
    },
  };
  db.withTransaction = async (fn) => fn(db); // duplicateRule
  return db;
}

async function send(chName, method, urlPath, payload) {
  const db = scriptedDb(chName);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use(require(`../routes/api.${chName}Ingest`));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const data = JSON.stringify(payload);
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => {
          let body = null;
          try { body = JSON.parse(raw || 'null'); } catch (_) { body = { __raw: raw }; }
          resolve({ status: r.statusCode, body });
        });
      });
      req.on('error', reject);
      req.end(data);
    });
    return { ...res, db };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const guestCode = require('../lib/guestCode');
const realRunBodies = guestCode.runBodies;
let guestRuns = 0;
const hits = () => guestRuns;

function expectRefused(r) {
  expect(r.status).toBe(403);
  expect(r.body.missingCapability).toBe('automations.manage');
  expect(r.body.error).toMatch(/automations\.manage/);
  expect(typeof r.body.message).toBe('string');
  expect(r.db.writes()).toEqual([]);
}

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(guestCode, 'runBodies').mockImplementation(async (body, inputs, ...rest) => {
    if (String(body).includes(HIT)) guestRuns += inputs.length;
    return realRunBodies(body, inputs, ...rest);
  });
});
afterAll(() => jest.restoreAllMocks());
beforeEach(() => { delete globalThis[HIT]; guestRuns = 0; });
afterEach(() => { expect(globalThis[HIT]).toBeUndefined(); });   // never the host's global

describe.each(['email', 'phone'])('%s ingest — code bodies need automations.manage', (ch) => {
  const base = `/api/${ch}-ingest`;
  const execId = CH[ch].execId;

  describe('POST rules/test-transform', () => {
    const codeBody = { transform_mode: 'code', transform_config: TRANSFORM_CODE, input: { subject: 'S' } };

    test('staff + code body: 403 and the body never runs', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'POST', `${base}/rules/test-transform`, codeBody);
      expectRefused(r);
      expect(hits()).toBe(0);
    });

    test('admin + code body: runs (the body executed once)', async () => {
      mockAuth = ADMIN;
      const r = await send(ch, 'POST', `${base}/rules/test-transform`, codeBody);
      expect(r.status).toBe(200);
      expect(r.body.transform).toEqual({ ok: true, output: { leaked: 'undefined' } });   // no process in the guest
      expect(hits()).toBe(1);
    });

    test('it role and a NULL-scopes machine key hold it; a route-scoped key does not', async () => {
      for (const [auth, status] of [[IT, 200], [LEGACY_KEY, 200], [ROUTE_KEY, 403]]) {
        mockAuth = auth;
        const r = await send(ch, 'POST', `${base}/rules/test-transform`, codeBody);
        expect([auth, r.status]).toEqual([auth, status]);
      }
      expect(hits()).toBe(2);
    });

    test('staff + mapper / passthrough: not gated', async () => {
      mockAuth = STAFF;
      const m = await send(ch, 'POST', `${base}/rules/test-transform`,
        { transform_mode: 'mapper', transform_config: MAPPER, input: { subject: 'S' } });
      expect(m.status).toBe(200);
      expect(m.body.transform).toEqual({ ok: true, output: { title: 'S' } });
      const p = await send(ch, 'POST', `${base}/rules/test-transform`, { transform_mode: 'passthrough', input: { a: 1 } });
      expect(p.status).toBe(200);
    });

    test('fails closed: an absent or unknown mode is gated for staff (admin: a 400, or a failed-transform result)', async () => {
      for (const body of [{ input: {} }, { transform_mode: 'Code', transform_config: TRANSFORM_CODE, input: {} }, { transform_mode: 'xslt', input: {} }]) {
        mockAuth = STAFF;
        expectRefused(await send(ch, 'POST', `${base}/rules/test-transform`, body));
        mockAuth = ADMIN;
        const r = await send(ch, 'POST', `${base}/rules/test-transform`, body);
        // absent mode is a request error; an unknown mode is a RESULT
        // (transform.ok false, "unknown transform_mode") — the golden's shape.
        if (body.transform_mode === undefined) expect(r.status).toBe(400);
        else expect([r.status, r.body.transform.ok]).toEqual([200, false]);
      }
      expect(hits()).toBe(0);
    });
  });

  describe('POST rules/test-match', () => {
    const codeBody = { match_mode: 'code', match_config: MATCH_CODE, exec_id: execId, include_misses: true };

    test('staff + code body: 403 and the body never runs', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'POST', `${base}/rules/test-match`, codeBody);
      expectRefused(r);
      expect(r.db.seen).toEqual([]); // not even the corpus fetch
      expect(hits()).toBe(0);
    });

    test('admin + code body: runs against the corpus', async () => {
      mockAuth = ADMIN;
      const r = await send(ch, 'POST', `${base}/rules/test-match`, codeBody);
      expect(r.status).toBe(200);
      expect(r.body.matched_count).toBe(1);
      expect(hits()).toBe(1);
    });

    test('staff + conditions: not gated', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'POST', `${base}/rules/test-match`, { match_mode: 'conditions', match_config: COND, exec_id: execId });
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
    });

    test('fails closed: an absent or unknown mode is gated for staff (and a 400 for admin)', async () => {
      for (const body of [{}, { match_mode: 'CODE', match_config: MATCH_CODE }, { match_mode: 'regex', match_config: {} }]) {
        mockAuth = STAFF;
        expectRefused(await send(ch, 'POST', `${base}/rules/test-match`, body));
        mockAuth = ADMIN;
        expect((await send(ch, 'POST', `${base}/rules/test-match`, body)).status).toBe(400);
      }
      expect(hits()).toBe(0);
    });
  });

  describe('POST rules (create)', () => {
    test('staff + code match or code transform: 403, nothing written', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'POST', `${base}/rules`, { name: 'x', match_mode: 'code', match_config: MATCH_CODE }));
      expectRefused(await send(ch, 'POST', `${base}/rules`,
        { name: 'x', match_mode: 'conditions', match_config: COND, transform_mode: 'code', transform_config: TRANSFORM_CODE }));
    });

    test('admin + code: created', async () => {
      mockAuth = ADMIN;
      const r = await send(ch, 'POST', `${base}/rules`,
        { name: 'x', match_mode: 'conditions', match_config: COND, transform_mode: 'code', transform_config: TRANSFORM_CODE });
      expect(r.status).toBe(201);
      expect(r.db.writes().filter((w) => /^\s*INSERT INTO \w+_ingest_rules/.test(w.sql))).toHaveLength(1);
    });

    test('staff + conditions/mapper: created', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'POST', `${base}/rules`,
        { name: 'x', match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER });
      expect(r.status).toBe(201);
      const a = await send(ch, 'POST', `${base}/rules`, { name: 'x', match_mode: 'conditions', match_config: COND });
      expect(a.status).toBe(201); // absent transform_mode = passthrough, not code
    });

    test('fails closed: a code-shaped config under a non-code mode is gated', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'POST', `${base}/rules`,
        { name: 'x', match_mode: 'conditions', match_config: { ...COND, code: 'return true;' } }));
      expectRefused(await send(ch, 'POST', `${base}/rules`,
        { name: 'x', match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: 'return {}' }));
      expectRefused(await send(ch, 'POST', `${base}/rules`, { name: 'x', match_mode: 'Code', match_config: MATCH_CODE }));
    });

    test('fails closed: an unknown mode is gated even with a config that is not code-shaped (admin: the validator 400s it)', async () => {
      const bodies = [
        { name: 'x', match_mode: 'regex', match_config: COND },
        { name: 'x', match_mode: 'conditions', match_config: COND, transform_mode: 'xslt', transform_config: MAPPER },
      ];
      for (const body of bodies) {
        mockAuth = STAFF;
        expectRefused(await send(ch, 'POST', `${base}/rules`, body));
        mockAuth = ADMIN;
        expect((await send(ch, 'POST', `${base}/rules`, body)).status).toBe(400);
      }
      mockAuth = STAFF;
      expectRefused(await send(ch, 'POST', `${base}/suppressions`, { name: 's', match_mode: 'Code', match_config: COND }));
    });
  });

  describe('PUT rules/:id (update)', () => {
    test('staff switching a rule to code, or editing code: 403, nothing written', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'PUT', `${base}/rules/2`, { transform_mode: 'code', transform_config: TRANSFORM_CODE }));
      expectRefused(await send(ch, 'PUT', `${base}/rules/2`, { match_mode: 'code', match_config: MATCH_CODE }));
      // config-only edit of a rule whose STORED transform is code
      expectRefused(await send(ch, 'PUT', `${base}/rules/1`, { transform_config: TRANSFORM_CODE }));
    });

    test('fails closed on the STORED mode: a config-only edit of a code rule is gated even when the config is not code-shaped', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'PUT', `${base}/rules/1`, { transform_config: MAPPER }));
      mockAuth = ADMIN; // the validator's answer, once past the gate
      expect((await send(ch, 'PUT', `${base}/rules/1`, { transform_config: MAPPER })).status).toBe(400);
    });

    test('staff config-only edit with a code-shaped config on a mapper rule: 403 (the mode-flip race)', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'PUT', `${base}/rules/2`, { transform_config: { code: 'return {};' } }));
    });

    test('admin editing code: updated', async () => {
      mockAuth = ADMIN;
      const r = await send(ch, 'PUT', `${base}/rules/1`, { transform_config: TRANSFORM_CODE });
      expect(r.status).toBe(200);
      expect(r.db.writes().filter((w) => /^\s*UPDATE \w+_ingest_rules/.test(w.sql))).toHaveLength(1);
    });

    test('staff edit that leaves the code side untouched: allowed (name / active on a code rule)', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'PUT', `${base}/rules/1`, { name: 'renamed', active: 0 });
      expect(r.status).toBe(200);
      expect(r.db.writes()).toHaveLength(1);
    });

    test('staff re-sending the WHOLE code rule (what the native editor does): refused — documented interaction', async () => {
      mockAuth = STAFF;
      const rule = storedRule(1, ch);
      expectRefused(await send(ch, 'PUT', `${base}/rules/1`, {
        name: 'renamed', description: null, active: 1, position: 0,
        match_mode: rule.match_mode, match_config: rule.match_config,
        transform_mode: rule.transform_mode, transform_config: rule.transform_config,
      }));
    });

    test('staff editing a non-code rule\'s conditions/mapper: allowed', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'PUT', `${base}/rules/2`,
        { match_mode: 'conditions', match_config: COND, transform_mode: 'mapper', transform_config: MAPPER });
      expect(r.status).toBe(200);
    });

    test('staff switching a code transform AWAY from code: allowed', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'PUT', `${base}/rules/1`, { transform_mode: 'passthrough', transform_config: null });
      expect(r.status).toBe(200);
    });
  });

  describe('suppressions', () => {
    test('staff create in code mode: 403, nothing written; admin: created', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'POST', `${base}/suppressions`, { name: 's', match_mode: 'code', match_config: MATCH_CODE }));
      mockAuth = ADMIN;
      const r = await send(ch, 'POST', `${base}/suppressions`, { name: 's', match_mode: 'code', match_config: MATCH_CODE });
      expect(r.status).toBe(201);
      expect(r.db.writes()).toHaveLength(1);
    });

    test('staff create in conditions mode: created', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'POST', `${base}/suppressions`, { name: 's', match_mode: 'conditions', match_config: COND });
      expect(r.status).toBe(201);
    });

    test('staff update: switching to code, or a config-only edit of a code suppression → 403', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'PUT', `${base}/suppressions/2`, { match_mode: 'code', match_config: MATCH_CODE }));
      expectRefused(await send(ch, 'PUT', `${base}/suppressions/1`, { match_config: MATCH_CODE }));
      expectRefused(await send(ch, 'PUT', `${base}/suppressions/2`, { match_config: 'return true' })); // code-shaped
      expectRefused(await send(ch, 'POST', `${base}/suppressions`, { name: 's', match_config: MATCH_CODE })); // no mode
    });

    test('fails closed on the STORED mode: a config-only edit of a code suppression is gated even when the config is not code-shaped', async () => {
      mockAuth = STAFF;
      expectRefused(await send(ch, 'PUT', `${base}/suppressions/1`, { match_config: COND }));
      mockAuth = ADMIN;
      expect((await send(ch, 'PUT', `${base}/suppressions/1`, { match_config: COND })).status).toBe(400);
    });

    test('admin update of code: updated; staff name-only edit of a code suppression: allowed', async () => {
      mockAuth = ADMIN;
      expect((await send(ch, 'PUT', `${base}/suppressions/1`, { match_config: MATCH_CODE })).status).toBe(200);
      mockAuth = STAFF;
      const r = await send(ch, 'PUT', `${base}/suppressions/1`, { name: 'renamed' });
      expect(r.status).toBe(200);
      expect(r.db.writes()).toHaveLength(1);
    });

    test('staff editing a conditions suppression: allowed (mode + config, or config alone)', async () => {
      mockAuth = STAFF;
      const r = await send(ch, 'PUT', `${base}/suppressions/2`, { match_mode: 'conditions', match_config: COND });
      expect(r.status).toBe(200);
      const c = await send(ch, 'PUT', `${base}/suppressions/2`, { match_config: COND });
      expect(c.status).toBe(200);
    });
  });

  test('duplicate ignores its body, so a code body cannot ride it (left open on purpose)', async () => {
    mockAuth = STAFF;
    const r = await send(ch, 'POST', `${base}/rules/2/duplicate`, { transform_mode: 'code', transform_config: TRANSFORM_CODE });
    expect(r.status).toBe(201);
    const ins = r.db.writes().find((w) => /^\s*INSERT INTO \w+_ingest_rules/.test(w.sql));
    expect(ins.params).not.toContain('code');
    expect(JSON.stringify(ins.params)).not.toMatch(/ingestCodeGateHit/);
  });
});
