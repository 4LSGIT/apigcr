'use strict';
/**
 * tests/caseyJobCodeAction.test.js
 *
 * Safe code jobs (safe-mode S3) — the first automation-authoring action kind:
 * job.code_safe.create.v1. Casey composes a safe-mode code BODY; the reviewed
 * card creates a one-time scheduled job through POST /scheduled-jobs with
 * code_mode pinned 'safe' (QuickJS guest engine — lib/safeCodeRunner.js), so
 * an applied card schedules a computation, not server-side execution.
 *
 * Three surfaces pinned here:
 *   1. the normalizer — what a model-proposed draft must look like to become
 *      a card at all, and that the family's off switch (ruling 4) is real;
 *   2. the route's idempotency wiring — POST /scheduled-jobs honours an
 *      Idempotency-Key, because the engine sends the draft_id as one and a
 *      double-apply would schedule the code twice;
 *   3. the settings pair — the flag is registered in BOTH places, or cfg()
 *      throws and the normalizer dies instead of gating.
 *
 * The route-level permission shape (safe body roleless, standard body
 * capability-gated) lives in tests/caseyActionPermissions.test.js with the
 * other 26 kinds; the executor behaviour lives in tests/safeCodeMode.test.js.
 */

const path = require('path');
const { normalizeActionDraft } = require(path.join(__dirname, '..', 'services', 'assistantService'));

const throwingDb = { query: async (sql) => { throw new Error(`db touched: ${sql}`); } };
const EVIDENCE = [{ id: 'q1', purpose: 'Case C1 row', rows: [{ case_id: 'C1' }] }];

const draft = (over = {}) => ({
  kind: 'job.code_safe.create.v1',
  name: 'Deadline math',
  description: 'Computes the 30-day deadline',
  code: 'const d = new Date(input.filed); d.setDate(d.getDate() + 30); d.toISOString();',
  input: { filed: '2026-10-01T00:00:00Z' },
  delay: '10m',
  evidence: [],
  ...over,
});

afterEach(() => { delete process.env.CASEY_CODE_ACTIONS_ENABLED; });

describe('the normalizer: what becomes a card', () => {
  test('a valid draft normalizes without touching the database', async () => {
    const out = await normalizeActionDraft(throwingDb, draft(), []);
    expect(out).toMatchObject({
      kind: 'job.code_safe.create.v1', status: 'draft',
      name: 'Deadline math', description: 'Computes the 30-day deadline',
      input: { filed: '2026-10-01T00:00:00Z' }, schedule: { delay: '10m' }, evidence: [],
    });
    expect(typeof out.draft_id).toBe('string');
    expect(out.draft_id.length).toBeGreaterThan(10);
    expect(out.code).toContain('setDate');
    // code_mode is deliberately NOT a draft field: the request builder pins it.
    expect('code_mode' in out).toBe(false);
  });

  test('the family off switch (ruling 4): flag 0 means the kind does not exist', async () => {
    process.env.CASEY_CODE_ACTIONS_ENABLED = '0';
    await expect(normalizeActionDraft(throwingDb, draft(), []))
      .rejects.toThrow(/Action kind is unavailable/);
    process.env.CASEY_CODE_ACTIONS_ENABLED = '1';
    await expect(normalizeActionDraft(throwingDb, draft(), [])).resolves.toMatchObject({ status: 'draft' });
  });

  test('unsupported fields are refused — the model cannot smuggle keys toward the route', async () => {
    for (const extra of [{ code_mode: 'standard' }, { recurrence_rule: '* * * * *' },
                         { type: 'recurring' }, { credential_id: 3 }]) {
      await expect(normalizeActionDraft(throwingDb, draft(extra), []))
        .rejects.toThrow(/unsupported fields/);
    }
  });

  test('code is required, a string, and bounded', async () => {
    await expect(normalizeActionDraft(throwingDb, draft({ code: '' }), [])).rejects.toThrow(/code is required/);
    await expect(normalizeActionDraft(throwingDb, draft({ code: 42 }), [])).rejects.toThrow(/code is required/);
    await expect(normalizeActionDraft(throwingDb, draft({ code: 'x'.repeat(20001) }), []))
      .rejects.toThrow(/exceeds 20000/);
  });

  test('input must be a JSON object and bounded', async () => {
    await expect(normalizeActionDraft(throwingDb, draft({ input: [1, 2] }), [])).rejects.toThrow(/JSON object/);
    await expect(normalizeActionDraft(throwingDb, draft({ input: 'str' }), [])).rejects.toThrow(/JSON object/);
    await expect(normalizeActionDraft(throwingDb, draft({ input: { big: 'x'.repeat(10001) } }), []))
      .rejects.toThrow(/exceeds 10000/);
    const out = await normalizeActionDraft(throwingDb, draft({ input: undefined }), []);
    expect(out.input).toEqual({});
  });

  test('exactly one of delay or scheduled_time, each validated', async () => {
    await expect(normalizeActionDraft(throwingDb, draft({ delay: undefined }), []))
      .rejects.toThrow(/exactly one/);
    await expect(normalizeActionDraft(throwingDb,
      draft({ scheduled_time: '2030-01-01T00:00:00Z' }), [])).rejects.toThrow(/exactly one/);
    await expect(normalizeActionDraft(throwingDb, draft({ delay: '10 minutes' }), []))
      .rejects.toThrow(/delay must look like/);
    await expect(normalizeActionDraft(throwingDb,
      draft({ delay: undefined, scheduled_time: 'not-a-date' }), [])).rejects.toThrow(/valid datetime/);
    await expect(normalizeActionDraft(throwingDb,
      draft({ delay: undefined, scheduled_time: '2020-01-01T00:00:00Z' }), [])).rejects.toThrow(/in the past/);
    const timed = await normalizeActionDraft(throwingDb,
      draft({ delay: undefined, scheduled_time: '2030-01-01T00:00:00Z' }), []);
    expect(timed.schedule).toEqual({ scheduled_time: '2030-01-01T00:00:00.000Z' });
  });

  test('evidence is optional, but a cited ref must be real', async () => {
    const none = await normalizeActionDraft(throwingDb, draft({ evidence: undefined }), []);
    expect(none.evidence).toEqual([]);
    const cited = await normalizeActionDraft(throwingDb,
      draft({ evidence: [{ query_id: 'q1', row_number: 1 }] }), EVIDENCE);
    expect(cited.evidence).toEqual([{ query_id: 'q1', row_number: 1, label: 'Case C1 row' }]);
    await expect(normalizeActionDraft(throwingDb,
      draft({ evidence: [{ query_id: 'q9', row_number: 1 }] }), EVIDENCE))
      .rejects.toThrow(/outside this investigation/);
  });
});

describe('POST /scheduled-jobs honours the Idempotency-Key the card sends', () => {
  // The real router over a real socket, the fake pool shaped like the one in
  // tests/requestIdempotency.test.js: the module's own statements answered,
  // the scheduled_jobs INSERT served, everything else refused.
  const express = require('express');
  const http = require('http');

  let mockAuth = null;
  jest.mock('../lib/auth.jwtOrApiKey', () =>
    jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

  const { SQL } = require('../lib/requestIdempotency');

  function makeDb() {
    const idemRows = [];
    let nextId = 1;
    let jobInserts = 0;
    const db = {
      getConnection: async () => { throw new Error('no connections'); },
      async query(sql, params) {
        if (sql === SQL.claim) {
          const [user_id, scope, idem_key] = params;
          if (idemRows.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
            const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
          }
          const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null, updated_at: Date.now() };
          idemRows.push(row);
          return [{ insertId: row.id, affectedRows: 1 }];
        }
        if (sql === SQL.read) {
          const [user_id, scope, idem_key] = params;
          const row = idemRows.find((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key);
          return row ? [[{ id: row.id, status: row.status, result: row.result, age_s: 0 }]] : [[]];
        }
        if (sql === SQL.settle) {
          const [json, id] = params;
          const row = idemRows.find((r) => r.id === id && r.status === 'in_flight');
          if (!row) return [{ affectedRows: 0 }];
          row.status = 'applied'; row.result = JSON.parse(json);
          return [{ affectedRows: 1 }];
        }
        if (/INSERT INTO scheduled_jobs/.test(sql)) { jobInserts += 1; return [{ insertId: 42 + jobInserts }]; }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    db.counts = () => ({ jobInserts, idemRows: idemRows.length });
    return db;
  }

  function send(db, headers, payload) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/scheduled_jobs.js'));
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const srv = a.listen(0, () => {
        const req = http.request({
          port: srv.address().port, path: '/scheduled-jobs', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
        }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { srv.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }

  const JOB = { type: 'one_time', job_type: 'custom_code', code: '1;', code_mode: 'safe', delay: '10m', name: 'n' };

  test('the same key twice inserts ONE job and replays the first result', async () => {
    mockAuth = { type: 'jwt', userId: 2, roles: ['staff'] };
    const db = makeDb();
    const first = await send(db, { 'idempotency-key': 'draft-uuid-123' }, JOB);
    expect(first.status).toBe(201);
    expect(first.body.id).toBe(43);
    const second = await send(db, { 'idempotency-key': 'draft-uuid-123' }, JOB);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(43);
    expect(second.body.replayed).toBe(true);
    expect(db.counts()).toEqual({ jobInserts: 1, idemRows: 1 });
  });

  test('no key: two posts are two jobs and the idempotency table is never touched', async () => {
    mockAuth = { type: 'jwt', userId: 2, roles: ['staff'] };
    const db = makeDb();
    await send(db, {}, JOB);
    await send(db, {}, JOB);
    expect(db.counts()).toEqual({ jobInserts: 2, idemRows: 0 });
  });
});

describe('the settings pair', () => {
  test('the flag is registered in BOTH places, or the normalizer throws instead of gating', () => {
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('casey_code_actions_enabled')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(Object.keys(SETTINGS)).toContain('casey_code_actions_enabled');
    expect(SETTINGS.casey_code_actions_enabled).toMatchObject({ kind: 'system', type: 'bool' });
  });
});
