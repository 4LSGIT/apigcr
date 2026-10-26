'use strict';
/**
 * tests/ingestRuleChangeLog.test.js
 *
 * A20 slice 1 — services/ingestRuleChangeLog.js and its wiring into the email
 * and phone ingest routes, without a database (the real-engine proof is
 * tests/ingestRuleChangeLog.mysql.test.js, gated).
 *
 *   1. The pure pieces: the expected_base shape, the precondition compare, the
 *      409 body (P11's shape), the actor, the definition comparison (key-order
 *      blind; pipeline columns ignored), the activate/deactivate kinds, the
 *      log redaction (http URL + literal header values) and the size cap.
 *   2. The routes, on a scripted stub db that RECORDS every statement: a
 *      malformed expected_base is a 400 with nothing written on every writer;
 *      a stale one is the structured 409 with nothing but the row lock issued;
 *      the code gate still answers before either (403); and a call without
 *      expected_base issues no precondition at all.
 *   3. Append-only: no source file UPDATEs or DELETEs a change table.
 */

process.env.EMAIL_DOMAINS = '4lsg.com';

const fs = require('fs');
const path = require('path');

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const changeLog = require('../services/ingestRuleChangeLog');
const H = require('./helpers/ingestNativeSequence');

const STAFF = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
const TS = new Date('2026-10-27T14:05:00.123Z');

// ═════════════════════════════════════════════════════════════
// 1. pure
// ═════════════════════════════════════════════════════════════

describe('expected_base shape', () => {
  test.each([
    ['x'], [null], [[]], [{}], [{ definition_updated_at: '2026-10-27 14:05:00' }],
    [{ definition_updated_at: '2026-10-27T14:05:00' }], [{ definition_updated_at: 1761573900123 }],
    [{ definition_updated_at: '2026-13-45T99:99:99Z' }], [{ definition_updated_at: '2026-10-27T14:05:00Z', step_count: 1 }],
  ])('%j → a message', (eb) => {
    expect(typeof changeLog.expectedBaseShapeError(eb)).toBe('string');
  });
  test.each([
    ['2026-10-27T14:05:00.123Z'], ['2026-10-27T14:05:00Z'], ['2026-10-27T10:05:00.123-04:00'],
  ])('%s → ok', (v) => {
    expect(changeLog.expectedBaseShapeError({ definition_updated_at: v })).toBeNull();
  });
});

describe('assertExpectedBase', () => {
  test('absent base → no check at all', () => {
    expect(() => changeLog.assertExpectedBase({ definition_updated_at: TS }, undefined)).not.toThrow();
  });
  test('the same instant in any zone form passes', () => {
    for (const v of ['2026-10-27T14:05:00.123Z', '2026-10-27T10:05:00.123-04:00']) {
      expect(() => changeLog.assertExpectedBase({ definition_updated_at: TS }, { definition_updated_at: v })).not.toThrow();
    }
  });
  test('one millisecond off → StaleDefinitionError naming expected and actual', () => {
    let err;
    try {
      changeLog.assertExpectedBase({ definition_updated_at: TS }, { definition_updated_at: '2026-10-27T14:05:00.122Z' });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(changeLog.StaleDefinitionError);
    expect(err.conflict).toEqual({ changed: 'definition_updated_at', expected: '2026-10-27T14:05:00.122Z', actual: TS.toISOString() });
    expect(changeLog.conflictBody(err)).toEqual({ error: expect.stringMatching(/changed since this edit was prepared/), conflict: err.conflict });
  });
  test('a row with no stamp (pre-migration shape) is stale for any base', () => {
    expect(() => changeLog.assertExpectedBase({ definition_updated_at: undefined }, { definition_updated_at: TS.toISOString() }))
      .toThrow(changeLog.StaleDefinitionError);
  });
});

describe('actorFromAuth', () => {
  test('staff JWT, view-as, API key, internal key, nothing', () => {
    expect(changeLog.actorFromAuth(STAFF)).toEqual({ user_id: 2, key_id: null, label: 'staff' });
    expect(changeLog.actorFromAuth({ ...STAFF, impersonator: { userId: 1, username: 'fred' } }))
      .toEqual({ user_id: 2, key_id: null, label: 'staff (view-as by fred)' });
    expect(changeLog.actorFromAuth({ type: 'api_key', key_id: 17, key_label: 'casey-mgr' }))
      .toEqual({ user_id: null, key_id: 17, label: 'api_key:casey-mgr' });
    expect(changeLog.actorFromAuth({ type: 'api_key', key_label: 'internal' }))
      .toEqual({ user_id: null, key_id: null, label: 'api_key:internal' });
    expect(changeLog.actorFromAuth(undefined)).toEqual({ user_id: null, key_id: null, label: null });
  });
});

const RULE = (over = {}, actions = []) => ({
  id: 5, name: 'r', description: null, active: 1, position: 0, match_mode: 'conditions',
  match_config: { operator: 'and', conditions: [] }, transform_mode: 'passthrough', transform_config: null,
  match_count: 3, last_matched_at: TS, last_modified_by: 2, created_at: TS, updated_at: TS, definition_updated_at: TS,
  actions, ...over,
});
const ACT = (over = {}) => ({ id: 9, rule_id: 5, name: null, position: 0, active: 1, action_type: 'workflow', config: { workflow_id: 1 }, ...over });

describe('definitionChanged / updateKind', () => {
  const s = (r) => changeLog.snapshotOf(r);
  test('pipeline columns, the stamp, the actor and JSON key order are not a change', () => {
    const a = s(RULE({}, [ACT()]));
    const b = s(RULE({ match_count: 99, last_matched_at: new Date(), updated_at: new Date(), definition_updated_at: new Date(),
      last_modified_by: 7, match_config: { conditions: [], operator: 'and' } }, [ACT()]));
    expect(changeLog.definitionChanged(a, b)).toBe(false);
  });
  test('every definition field and every action field is a change', () => {
    const a = s(RULE({}, [ACT()]));
    for (const over of [{ name: 'x' }, { description: 'd' }, { active: 0 }, { position: 1 }, { match_mode: 'code' },
      { match_config: { operator: 'or', conditions: [] } }, { transform_mode: 'mapper' }, { transform_config: [] }]) {
      expect([over, changeLog.definitionChanged(a, s(RULE(over, [ACT()])))]).toEqual([over, true]);
    }
    for (const over of [{ name: 'n' }, { position: 1 }, { active: 0 }, { action_type: 'hook' }, { config: { workflow_id: 2 } }]) {
      expect([over, changeLog.definitionChanged(a, s(RULE({}, [ACT(over)])))]).toEqual([over, true]);
    }
    expect(changeLog.definitionChanged(a, s(RULE({}, [])))).toBe(true);
    expect(changeLog.definitionChanged(a, s(RULE({}, [ACT(), ACT({ id: 10 })])))).toBe(true);
  });
  test('active alone → activate / deactivate; anything with it → update', () => {
    const off = s(RULE({ active: 0 }));
    const on = s(RULE({ active: 1 }));
    expect(changeLog.updateKind(off, on)).toBe('activate');
    expect(changeLog.updateKind(on, off)).toBe('deactivate');
    expect(changeLog.updateKind(off, s(RULE({ active: 1, name: 'x' })))).toBe('update');
    expect(changeLog.updateKind(on, s(RULE({ active: 1, name: 'x' })))).toBe('update');
  });
});

describe('the log copy: redaction and cap', () => {
  const http = ACT({ id: 11, action_type: 'http', config: { url: 'https://hooks.example.com/t/SECRET', method: 'POST',
    headers: { Authorization: 'Bearer SECRET2', 'X-Trace': 'SECRET3' }, body_template: '{"a":1}' } });
  test('http URL → host only, literal header values → [redacted]; names, method, template kept; other actions untouched', () => {
    const snap = changeLog.snapshotOf(RULE({}, [ACT(), http]));
    const text = changeLog.sideJson(snap);
    expect(text).not.toMatch(/SECRET/);
    const out = JSON.parse(text);
    expect(out.actions[1].config).toEqual({ url: '[redacted — host hooks.example.com]', method: 'POST',
      headers: { Authorization: '[redacted]', 'X-Trace': '[redacted]' }, body_template: '{"a":1}' });
    expect(out.actions[0].config).toEqual({ workflow_id: 1 });
    // the comparison still sees a header VALUE change
    const rotated = changeLog.snapshotOf(RULE({}, [ACT(), ACT({ ...http, config: { ...http.config, headers: { Authorization: 'Bearer NEW', 'X-Trace': 'SECRET3' } } })]));
    expect(changeLog.definitionChanged(snap, rotated)).toBe(true);
    expect(changeLog.sideJson(rotated)).toBe(text);
  });
  test('an unparseable URL redacts whole', () => {
    const snap = changeLog.snapshotOf(RULE({}, [ACT({ action_type: 'http', config: { url: 'not a url SECRET' } })]));
    expect(JSON.parse(changeLog.sideJson(snap)).actions[0].config.url).toBe('[redacted]');
  });
  test('over the cap → a size + sha256 marker, under it → the snapshot', () => {
    const big = changeLog.snapshotOf(RULE({ transform_mode: 'code', transform_config: { code: 'x'.repeat(changeLog.SNAPSHOT_CAP_BYTES) } }));
    const m = JSON.parse(changeLog.sideJson(big));
    expect(m).toEqual({ _omitted: 'snapshot_too_large', bytes: expect.any(Number), cap: changeLog.SNAPSHOT_CAP_BYTES,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/), rule: { id: 5, name: 'r' } });
    expect(m.bytes).toBeGreaterThan(changeLog.SNAPSHOT_CAP_BYTES);
    const live = changeLog.snapshotOf(RULE({ transform_mode: 'code', transform_config: { code: 'x'.repeat(12142) } }));
    expect(JSON.parse(changeLog.sideJson(live)).rule.transform_config.code).toHaveLength(12142);
  });
  test('insertChange refuses a kind outside the vocabulary', async () => {
    const conn = { query: jest.fn() };
    await expect(changeLog.insertChange(conn, changeLog.CHANNELS.email, { ruleId: 1, kind: 'edit' })).rejects.toThrow(/unknown change kind/);
    expect(conn.query).not.toHaveBeenCalled();
    expect([...changeLog.KINDS].sort()).toEqual(['action_add', 'action_delete', 'action_update', 'activate', 'create',
      'deactivate', 'delete', 'duplicate', 'update']);
  });
});

// ═════════════════════════════════════════════════════════════
// 2. the routes, on a recording stub
// ═════════════════════════════════════════════════════════════

const LIVE = new Date('2026-10-27T14:05:00.123Z');

function stubDb(ch) {
  const seen = [];
  const rule = (id) => ({ ...RULE({ id }), definition_updated_at: LIVE });
  const db = {
    seen,
    writes: () => seen.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.sql) && !/admin_audit_log/.test(s.sql)),
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, ' ');
      seen.push({ sql: s, params });
      if (/^\s*INSERT/i.test(s)) return [{ insertId: 77, affectedRows: 1 }];
      if (/^\s*(UPDATE|DELETE)/i.test(s)) return [{ affectedRows: 1 }];
      if (new RegExp(`FROM ${ch}_ingest_rules WHERE id = \\?`).test(s)) return [[rule(Number(params[0]))]];
      if (new RegExp(`FROM ${ch}_ingest_rule_actions WHERE id = \\?`).test(s)) return [[ACT({ id: Number(params[0]) })]];
      if (/_rule_actions/.test(s)) return [[ACT()]];
      if (/FROM workflows WHERE id = \?/.test(s)) return [[{ id: 1, active: 1 }]];
      throw new Error(`unscripted SQL: ${s}`);
    },
  };
  db.withTransaction = async (fn) => fn(db);
  return db;
}

async function call(ch, method, urlPath, body) {
  const db = stubDb(ch);
  const m = await H.mount(require(`../routes/api.${ch}Ingest`), db);
  try {
    const r = await m.send(method, urlPath, body);
    return { ...r, db };
  } finally { await m.close(); }
}

beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => jest.restoreAllMocks());

describe.each(['email', 'phone'])('%s routes', (ch) => {
  const base = `/api/${ch}-ingest`;
  const WRITERS = [
    ['PUT rule', 'PUT', `${base}/rules/5`, { name: 'x' }],
    ['DELETE rule', 'DELETE', `${base}/rules/5`, {}],
    ['duplicate', 'POST', `${base}/rules/5/duplicate`, {}],
    ['POST action', 'POST', `${base}/rules/5/actions`, { action_type: 'workflow', config: { workflow_id: 1 } }],
    ['PUT action', 'PUT', `${base}/rule-actions/9`, { name: 'x' }],
    ['DELETE action', 'DELETE', `${base}/rule-actions/9`, {}],
  ];

  test.each(WRITERS)('%s: a malformed expected_base is a 400 and nothing is written or locked', async (_l, method, p, body) => {
    mockAuth = STAFF;
    const r = await call(ch, method, p, { ...body, expected_base: { definition_updated_at: '2026-10-27 14:05:00' } });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'validation_failed', field: 'expected_base', message: expect.stringMatching(/ISO-8601/) });
    expect(r.db.writes()).toEqual([]);
    expect(r.db.seen.filter((s) => /FOR UPDATE/.test(s.sql))).toEqual([]);
  });

  test.each(WRITERS)('%s: a stale expected_base is the structured 409; only the lock ran, nothing written', async (_l, method, p, body) => {
    mockAuth = STAFF;
    const stale = '2026-10-27T14:05:00.122Z';
    const r = await call(ch, method, p, { ...body, expected_base: { definition_updated_at: stale } });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: expect.stringMatching(/changed since this edit was prepared/),
      conflict: { changed: 'definition_updated_at', expected: stale, actual: LIVE.toISOString() } });
    expect(r.db.writes()).toEqual([]);
    expect(r.db.seen.filter((s) => new RegExp(`FROM ${ch}_ingest_rules WHERE id = \\? FOR UPDATE`).test(s.sql))).toHaveLength(1);
  });

  test.each(WRITERS)('%s: the matching expected_base passes the check', async (_l, method, p, body) => {
    mockAuth = STAFF;
    const r = await call(ch, method, p, { ...body, expected_base: { definition_updated_at: LIVE.toISOString() } });
    expect(r.status).not.toBe(409);
    expect(r.status).toBeLessThan(300);
  });

  test('the code gate answers before the shape check and the precondition', async () => {
    mockAuth = STAFF;
    for (const eb of [{ definition_updated_at: 'junk' }, { definition_updated_at: '2020-01-01T00:00:00Z' }]) {
      const r = await call(ch, 'PUT', `${base}/rules/5`, { match_mode: 'code', match_config: { code: 'return true;' }, expected_base: eb });
      expect(r.status).toBe(403);
      expect(r.body.missingCapability).toBe('automations.manage');
      expect(r.db.writes()).toEqual([]);
    }
  });

  test('create: actor recorded, expected_base ignored (there is no base yet)', async () => {
    mockAuth = STAFF;
    const r = await call(ch, 'POST', `${base}/rules`, { name: 'n', match_mode: 'conditions', match_config: { operator: 'and', conditions: [] },
      expected_base: { definition_updated_at: 'junk' } });
    expect(r.status).toBe(201);
    const ins = r.db.writes().find((w) => w.sql.includes(`INSERT INTO ${ch}_ingest_rule_changes`));
    expect(ins.params.slice(0, 7)).toEqual([77, 'create', null, null, 2, null, 'staff']);
  });
});

// ═════════════════════════════════════════════════════════════
// 3. append-only
// ═════════════════════════════════════════════════════════════

test('no source file UPDATEs or DELETEs a change table (append-only)', () => {
  const REPO = path.join(__dirname, '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', 'tests', 'ref', 'manual', '.claude'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(REPO);
  expect(files.length).toBeGreaterThan(100);
  const bad = [];
  const re = /(UPDATE\s+`?|DELETE\s+FROM\s+`?|TRUNCATE\s+(TABLE\s+)?`?|DROP\s+TABLE\s+(IF\s+EXISTS\s+)?`?)(email|phone)_ingest_rule_changes\b/i;
  for (const f of files) if (re.test(fs.readFileSync(f, 'utf8'))) bad.push(path.relative(REPO, f));
  expect(bad).toEqual([]);
});
