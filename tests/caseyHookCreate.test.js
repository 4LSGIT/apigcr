'use strict';
/**
 * tests/caseyHookCreate.test.js
 *
 * A19.0 — Casey creates an INACTIVE inbound hook with one internal target
 * (an existing workflow or sequence template). Pinned here:
 *   1. the normalizer: targets must EXIST (read at proposal time), HTTP
 *      targets are refused, the family off switch is real, and no slug/key/
 *      URL field exists anywhere in the draft shape;
 *   2. the extended POST /api/hooks route: inline targets are validated with
 *      the same rules as the target route, created in one transaction, and
 *      the whole create honours an Idempotency-Key — a retry cannot mint a
 *      second inbound endpoint;
 *   3. the settings pair.
 */

const path = require('path');
const { normalizeActionDraft } = require(path.join(__dirname, '..', 'services', 'assistantService'));

const dbWith = (rows) => ({ query: jest.fn(async (sql) => {
  if (/FROM workflows WHERE id/.test(sql)) return [rows.workflow ? [rows.workflow] : []];
  if (/FROM sequence_templates WHERE id/.test(sql)) return [rows.sequence ? [rows.sequence] : []];
  throw new Error(`db touched: ${sql}`);
}) });

const draft = (over = {}) => ({
  kind: 'hook.create.v1',
  name: 'Site form → intake',
  description: 'Inbound site submissions start the intake workflow.',
  target: { kind: 'workflow', workflow_id: 27 },
  evidence: [],
  ...over,
});

afterEach(() => { delete process.env.CASEY_HOOK_AUTHORING_ENABLED; });

describe('the hook normalizer', () => {
  test('a valid workflow target normalizes with its live label and published flag', async () => {
    const out = await normalizeActionDraft(
      dbWith({ workflow: { id: 27, name: 'static site hit', active: 1, current_version: 8 } }), draft(), []);
    expect(out).toMatchObject({
      kind: 'hook.create.v1', status: 'draft', name: 'Site form → intake',
      target: { kind: 'workflow', workflow_id: 27, label: 'static site hit', published: 1 },
    });
    // No slug, key, or URL exists anywhere in the draft shape.
    expect(JSON.stringify(out)).not.toMatch(/slug|"url"|api_key|auth_config/i);
  });

  test('an UNPUBLISHED target workflow is allowed but flagged for the card', async () => {
    const out = await normalizeActionDraft(
      dbWith({ workflow: { id: 61, name: 'Deadline chase', active: 1, current_version: 0 } }),
      draft({ target: { kind: 'workflow', workflow_id: 61 } }), []);
    expect(out.target.published).toBe(0);
  });

  test('a sequence target must exist too', async () => {
    const out = await normalizeActionDraft(
      dbWith({ sequence: { id: 5, name: 'No-show chase', active: 1 } }),
      draft({ target: { kind: 'sequence', sequence_template_id: 5 } }), []);
    expect(out.target).toMatchObject({ kind: 'sequence', sequence_template_id: 5, label: 'No-show chase' });
    await expect(normalizeActionDraft(dbWith({}),
      draft({ target: { kind: 'sequence', sequence_template_id: 999 } }), []))
      .rejects.toThrow(/sequence template 999 does not exist/);
  });

  test('nonexistent workflows, HTTP targets, and extra keys are refused by name', async () => {
    await expect(normalizeActionDraft(dbWith({}), draft(), []))
      .rejects.toThrow(/workflow 27 does not exist/);
    await expect(normalizeActionDraft(dbWith({}),
      draft({ target: { kind: 'http' } }), []))
      .rejects.toThrow(/HTTP targets are not authorable|target object/);
    await expect(normalizeActionDraft(dbWith({}),
      draft({ slug: 'my-endpoint' }), []))
      .rejects.toThrow(/unsupported fields/);
    await expect(normalizeActionDraft(dbWith({}),
      draft({ target: { kind: 'workflow', workflow_id: 27, url: 'https://x' } }), []))
      .rejects.toThrow(/target object/);
  });

  test('the family off switch makes the kind not exist', async () => {
    process.env.CASEY_HOOK_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(dbWith({}), draft(), []))
      .rejects.toThrow(/Action kind is unavailable/);
  });
});

describe('POST /api/hooks with inline targets, idempotent', () => {
  const express = require('express');
  const http = require('http');

  const { SQL } = require('../lib/requestIdempotency');

  // The real router needs requireAuth to pass: a real staff JWT with the
  // capability roles, same signing idiom as the permissions matrix.
  const jwt = require('jsonwebtoken');
  const SECRET = 'casey-hook-test-secret';
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = OLD_SECRET; });
  const token = () => jwt.sign({ sub: 1, username: 'admin', user_type: 1, aud: 'staff',
    user_auth: 'authorized', roles: ['admin', 'staff'],
    ...(process.env.JWT_VERSION ? { ver: parseInt(process.env.JWT_VERSION, 10) } : {}),
  }, SECRET, { expiresIn: '5m' });

  function makeDb() {
    const idemRows = [];
    let nextId = 1;
    let hookCreates = 0;
    const targetRows = [];
    const base = {
      getConnection: async () => { throw new Error('no connections'); },
      withTransaction: async (fn) => fn(connFor()),
      async query(sql, params) {
        if (/INSERT INTO jwt_api_audit_log/.test(sql)) return [{ affectedRows: 1 }];
        if (sql === SQL.claim) {
          const [user_id, scope, idem_key] = params;
          if (idemRows.some((r) => r.user_id === user_id && r.scope === scope && r.idem_key === idem_key)) {
            const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
          }
          const row = { id: nextId++, user_id, scope, idem_key, status: 'in_flight', result: null };
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
        throw new Error(`unexpected pool SQL: ${sql}`);
      },
    };
    function connFor() {
      return { query: async (sql, params) => {
        if (/INSERT INTO hooks SET/.test(sql)) { hookCreates += 1; return [{ insertId: 11 + hookCreates }]; }
        if (/INSERT INTO hook_targets/.test(sql) || /hook_targets/.test(sql)) { targetRows.push(params); return [{ insertId: 90 + targetRows.length }]; }
        throw new Error(`unexpected conn SQL: ${sql}`);
      } };
    }
    base.counts = () => ({ hookCreates, targets: targetRows.length, idemRows: idemRows.length });
    return base;
  }

  function send(db, headers, payload) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = db; next(); });
    a.use(require('../routes/api.hooks.js'));
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const srv = a.listen(0, () => {
        const req = http.request({
          port: srv.address().port, path: '/api/hooks', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
            authorization: `Bearer ${token()}`, ...headers },
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

  const BODY = { name: 'Site form → intake', active: 0,
    targets: [{ name: '→ intake', target_type: 'workflow', config: { workflow_id: 27 }, active: 1 }] };

  test('one key, one hook: the replay returns the first id and creates nothing twice', async () => {
    const db = makeDb();
    const first = await send(db, { 'idempotency-key': 'hook-draft-1' }, BODY);
    expect(first.status).toBe(200);
    expect(first.body.id).toBe(12);
    expect(first.body.target_ids).toEqual([91]);
    const second = await send(db, { 'idempotency-key': 'hook-draft-1' }, BODY);
    expect(second.body.id).toBe(12);
    expect(second.body.replayed).toBe(true);
    expect(db.counts()).toEqual({ hookCreates: 1, targets: 1, idemRows: 1 });
  });

  test('a bad inline target is refused up front with the target-route rules, before any write', async () => {
    const db = makeDb();
    const r = await send(db, {}, { name: 'h', active: 0,
      targets: [{ name: 't', target_type: 'workflow', config: {} }] });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/targets\[0\].*workflow_id/);
    expect(db.counts().hookCreates).toBe(0);
  });
});

describe('the settings pair', () => {
  test('the flag is registered in BOTH places', () => {
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('casey_hook_authoring_enabled')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(SETTINGS.casey_hook_authoring_enabled).toMatchObject({ kind: 'system', type: 'bool' });
  });
});
