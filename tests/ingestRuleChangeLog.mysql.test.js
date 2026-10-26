'use strict';
/**
 * tests/ingestRuleChangeLog.mysql.test.js
 *
 * A20 slice 1 — the ingest rule EDIT STAMP (definition_updated_at), the
 * append-only CHANGE LOG (<channel>_ingest_rule_changes) and the stale-edit
 * PRECONDITION (expected_base), on a REAL MySQL engine, both channels.
 * services/ingestRuleChangeLog.js + the CRUD in
 * services/{email,phone}IngestRuleService.js + routes/api.{email,phone}Ingest.js.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * The gated-suite protocol (tests/mailboxS2.mysql.test.js header): ONE fresh
 * throwaway *_test database loaded from ref/database.sql plus the zoneinfo
 * tables, --runInBand. Run 2026-10-27 on MySQL 8.4.11:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3377/yc_a20s1_test npx jest tests/ingestRuleChangeLog.mysql.test.js --runInBand
 * beforeAll applies scripts/ingestRuleEditStampAndChangeLog.js (idempotent —
 * ALREADY APPLIED once ref/database.sql carries the migration). The suite
 * DELETEs and re-seeds the ingest rule tables, the change tables and workflow 31.
 * Never point it at port 3306 (the production proxy) — it refuses.
 *
 * WHAT IS LOCKED
 *   (a) a MATCH (evaluateRules → the fire-and-forget match_count bump) does
 *       NOT move definition_updated_at, while it DOES still move updated_at
 *       (the landmine the stamp exists for);
 *   (b) every real definition edit moves it — rule create / update /
 *       activate / deactivate / duplicate / delete, and action add / update /
 *       delete moving the PARENT's stamp — strictly increasing even with the
 *       clock behind; a no-op save moves nothing and logs nothing; action
 *       edits and the bump never move updated_at; each change row carries the
 *       kind, actor, stamp, and the rule WITH its action rows before/after,
 *       http URL + literal header values redacted (the action row keeps them);
 *   (c) the change row is written IN the edit's transaction: a failure after
 *       the log insert (the commit) rolls both back; a failed log insert rolls
 *       the edit back;
 *   (d) a stale expected_base is a structured 409 on every writer and writes
 *       NOTHING (full row snapshot of rules, actions, change log); the right
 *       one succeeds — including on a busy rule whose updated_at a match just
 *       moved (the spurious-stale case updated_at could not avoid); a bad
 *       shape is a 400 with nothing written; two racing writers on one base:
 *       exactly one wins; the code gate still answers first (403, not 409);
 *   (e) native calls WITHOUT expected_base return exactly the bodies the
 *       pre-slice code returned (tests/fixtures/ingestNativeGolden.json,
 *       recorded from 2c1c86a by the same call sequence,
 *       tests/helpers/ingestNativeSequence.js) plus one key,
 *       definition_updated_at, on every rule object.
 *   No action is ever dispatched: actionDispatchers.dispatch and
 *   hookService.executeHook are spied and must stay uncalled.
 */

process.env.EMAIL_DOMAINS = '4lsg.com';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const STAFF = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
const KEY = { type: 'api_key', key_id: 17, key_label: 'casey-mgr', scopes: null };
const ALWAYS = { operator: 'and', conditions: [] };
const SECRET_URL = 'https://hooks.example.com/t/SECRET-TOKEN-abc123';
const SECRET_HEADER = 'literal-header-SECRET-value';
const WF = 31;

maybe('ingest rule edit stamp + change log + precondition on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const { withTransaction } = require('../lib/withTransaction');
  const changeLog = require('../services/ingestRuleChangeLog');
  const migration = require('../scripts/ingestRuleEditStampAndChangeLog');
  const actionDispatchers = require('../lib/actionDispatchers');
  const hookService = require('../services/hookService');
  const H = require('./helpers/ingestNativeSequence');
  const GOLDEN = require('./fixtures/ingestNativeGolden.json');

  const SVC = {
    email: require('../services/emailIngestRuleService'),
    phone: require('../services/phoneIngestRuleService'),
  };
  const ROUTER = {
    email: () => require('../routes/api.emailIngest'),
    phone: () => require('../routes/api.phoneIngest'),
  };
  const T = changeLog.CHANNELS;

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    if (Number(u.port) === 3306) throw new Error('port 3306 is the production proxy — refusing');
    pool = mysql.createPool({ host: u.hostname, port: Number(u.port), database, timezone: 'Z', connectionLimit: 4,
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    pool.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    pool.withTransaction = (fn, o) => withTransaction(pool, fn, o);

    const conn = await pool.getConnection();
    try {
      const r = await migration.run(conn, { apply: true, log: () => {} });
      if (!r.ok) throw new Error(`migration did not apply: ${r.line}`);
    } finally { conn.release(); }

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(actionDispatchers, 'dispatch').mockImplementation(async () => { throw new Error('TRIPWIRE: dispatch'); });
    jest.spyOn(hookService, 'executeHook').mockImplementation(async () => { throw new Error('TRIPWIRE: executeHook'); });

    await q(`INSERT INTO workflows (id, name, active, current_version) VALUES (${WF}, 'golden target', 1, 1)
             ON DUPLICATE KEY UPDATE active = 1`);
  });

  afterAll(async () => {
    try {
      expect(actionDispatchers.dispatch).not.toHaveBeenCalled();
      expect(hookService.executeHook).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      if (pool) await pool.end();
    }
  });

  async function reset(ch) {
    await q(`DELETE FROM ${T[ch].rules}`);
    await q(`DELETE FROM ${T[ch].changes}`);
    await q(`ALTER TABLE ${T[ch].rules} AUTO_INCREMENT = 1000`);
    await q(`ALTER TABLE ${T[ch].actions} AUTO_INCREMENT = 1000`);
  }
  const ruleRow = async (ch, id) => (await q(`SELECT * FROM ${T[ch].rules} WHERE id = ?`, [id]))[0];
  const stampMs = async (ch, id) => +(await ruleRow(ch, id)).definition_updated_at;
  const changes = (ch, id) => q(`SELECT * FROM ${T[ch].changes} WHERE rule_id = ? ORDER BY id`, [id]);
  // Every row of the three tables a write could touch, key-order-insensitive.
  async function snapshot(ch) {
    const out = {};
    for (const t of [T[ch].rules, T[ch].actions, T[ch].changes]) {
      out[t] = JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`));
    }
    return out;
  }
  const newRule = (ch, over = {}) => SVC[ch].createRule(pool, {
    name: `${ch} rule`, match_mode: 'conditions', match_config: ALWAYS, active: 0, ...over,
  }, 2, { actor: changeLog.actorFromAuth(STAFF) });
  const envelope = (ch) => (ch === 'email'
    ? { kind: 'email', from: { email: 'a@b.example' }, to: [{ email: 'docs@4lsg.com' }], subject: 'S', text: 't', headers: {} }
    : { type: 'sms', from: '2485550100', to: '3135550199', message: 'hi', extra: {}, data: {} });
  async function waitFor(fn, ms = 3000) {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  describe.each(['email', 'phone'])('%s', (ch) => {
    const base = `/api/${ch}-ingest`;
    let srv;
    beforeAll(async () => { srv = await H.mount(ROUTER[ch](), pool); });
    afterAll(async () => { if (srv) await srv.close(); });

    // ── (e) the native golden ──────────────────────────────────────────
    test('(e) native calls without expected_base return the pre-slice bodies, plus definition_updated_at', async () => {
      await reset(ch);
      mockAuth = STAFF;
      const steps = await H.runNativeSequence(srv.send, ch, { workflowId: WF });
      const stamps = [];
      const got = H.normalize(steps, { stamps });
      expect(got).toEqual(GOLDEN.channels[ch]);
      // every rule object carried the stamp, as the ISO instant GET returns
      const ruleObjects = steps.reduce((n, s) => n + (s.body && s.body.rule ? 1 : 0)
        + (s.body && Array.isArray(s.body.rules) ? s.body.rules.length : 0), 0);
      expect(ruleObjects).toBeGreaterThan(5);
      expect(stamps).toHaveLength(ruleObjects);
      for (const s of stamps) expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // and the log saw exactly the real changes, in order (no-ops and refusals logged nothing)
      const kinds = (await q(`SELECT change_kind FROM ${T[ch].changes} ORDER BY id`)).map((r) => r.change_kind);
      expect(kinds).toEqual(['create', 'update', 'action_add', 'action_update', 'duplicate', 'action_delete', 'delete', 'delete']);
    });

    // ── (a) a match does not move the stamp ────────────────────────────
    test('(a) a match bumps match_count and updated_at but NOT definition_updated_at, and logs nothing', async () => {
      await reset(ch);
      const r = await newRule(ch, { active: 1 });
      await q(`UPDATE ${T[ch].rules} SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`, [r.id]);
      const before = await ruleRow(ch, r.id);
      const logBefore = (await changes(ch, r.id)).length;
      const out = await SVC[ch].evaluateRules(pool, envelope(ch));
      expect(out.matchedRuleIds).toEqual([r.id]);
      await waitFor(async () => (await ruleRow(ch, r.id)).match_count === before.match_count + 1);
      const after = await ruleRow(ch, r.id);
      expect(+after.definition_updated_at).toBe(+before.definition_updated_at);
      expect(+after.updated_at).not.toBe(+before.updated_at);           // the landmine, still there
      expect((await changes(ch, r.id)).length).toBe(logBefore);
    });

    // ── (b) every definition edit moves it ─────────────────────────────
    test('(b) rule edits: create, update, activate, deactivate, no-op — stamp + log row each, strictly increasing', async () => {
      await reset(ch);
      const r = await newRule(ch);
      const s0 = await stampMs(ch, r.id);
      expect(r.definition_updated_at).toBeInstanceOf(Date);
      let [c] = await changes(ch, r.id);
      expect(c).toMatchObject({ change_kind: 'create', action_id: null, actor_user_id: 2, actor_label: 'staff', before_json: null });
      expect(+c.definition_updated_at).toBe(s0);
      expect(c.after_json.rule).toMatchObject({ id: r.id, name: `${ch} rule`, active: 0 });
      expect(c.after_json.actions).toEqual([]);

      const opts = { actor: changeLog.actorFromAuth(KEY) };
      await SVC[ch].updateRule(pool, r.id, { name: 'renamed', position: 4 }, undefined, opts);
      const s1 = await stampMs(ch, r.id);
      expect(s1).toBeGreaterThan(s0);
      await SVC[ch].updateRule(pool, r.id, { active: 1 }, undefined, opts);
      const s2 = await stampMs(ch, r.id);
      await SVC[ch].updateRule(pool, r.id, { active: 0 }, undefined, opts);
      const s3 = await stampMs(ch, r.id);
      expect(s2).toBeGreaterThan(s1);
      expect(s3).toBeGreaterThan(s2);

      // a save that changes nothing: no stamp, no row (updated_at still moves — existing behaviour)
      await SVC[ch].updateRule(pool, r.id, { name: 'renamed', active: 0, match_config: { conditions: [], operator: 'and' } }, undefined, opts);
      expect(await stampMs(ch, r.id)).toBe(s3);

      const rows = await changes(ch, r.id);
      expect(rows.map((x) => x.change_kind)).toEqual(['create', 'update', 'activate', 'deactivate']);
      expect(rows[1]).toMatchObject({ actor_user_id: null, actor_key_id: 17, actor_label: 'api_key:casey-mgr' });
      expect(rows[1].before_json.rule).toMatchObject({ name: `${ch} rule`, position: 0 });
      expect(rows[1].after_json.rule).toMatchObject({ name: 'renamed', position: 4 });
      expect(rows.map((x) => +x.definition_updated_at)).toEqual([s0, s1, s2, s3]);

      // clock behind the stored stamp: the next edit still moves it FORWARD (+1 ms)
      await q(`UPDATE ${T[ch].rules} SET definition_updated_at = NOW(3) + INTERVAL 1 HOUR WHERE id = ?`, [r.id]);
      const ahead = await stampMs(ch, r.id);
      await SVC[ch].updateRule(pool, r.id, { description: 'x' }, undefined, opts);
      expect(await stampMs(ch, r.id)).toBe(ahead + 1);
    });

    test('(b) action add / update / delete move the PARENT stamp (never updated_at); duplicate and delete log the whole rule', async () => {
      await reset(ch);
      const r = await newRule(ch);
      await q(`UPDATE ${T[ch].rules} SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`, [r.id]);
      const upd = async () => +(await ruleRow(ch, r.id)).updated_at;
      const u0 = await upd();
      const opts = { actor: changeLog.actorFromAuth(STAFF) };
      const s0 = await stampMs(ch, r.id);

      const a = await SVC[ch].addAction(pool, r.id, { action_type: 'workflow', config: { workflow_id: WF }, name: 'wf' }, opts);
      const s1 = await stampMs(ch, r.id);
      const h = await SVC[ch].addAction(pool, r.id, { action_type: 'http', name: 'vendor',
        config: { url: SECRET_URL, method: 'POST', headers: { 'X-Static-Secret': SECRET_HEADER } } }, opts);
      const s2 = await stampMs(ch, r.id);
      await SVC[ch].updateAction(pool, a.id, { position: 2 }, opts);
      const s3 = await stampMs(ch, r.id);
      await SVC[ch].updateAction(pool, a.id, { position: 2 }, opts);            // no-op
      expect(await stampMs(ch, r.id)).toBe(s3);
      // a header VALUE change is a real change even though the log copy redacts it
      await SVC[ch].updateAction(pool, h.id, { config: { url: SECRET_URL, method: 'POST', headers: { 'X-Static-Secret': 'rotated' } } }, opts);
      const s4 = await stampMs(ch, r.id);
      await SVC[ch].deleteAction(pool, a.id, opts);
      const s5 = await stampMs(ch, r.id);
      for (const [x, y] of [[s0, s1], [s1, s2], [s2, s3], [s3, s4], [s4, s5]]) expect(y).toBeGreaterThan(x);
      expect(await upd()).toBe(u0);                                            // updated_at never moved

      const rows = await changes(ch, r.id);
      expect(rows.map((x) => [x.change_kind, x.action_id])).toEqual([
        ['create', null], ['action_add', a.id], ['action_add', h.id], ['action_update', a.id],
        ['action_update', h.id], ['action_delete', a.id]]);
      expect(rows[1].before_json.actions).toEqual([]);
      expect(rows[1].after_json.actions).toEqual([expect.objectContaining({ id: a.id, action_type: 'workflow', config: { workflow_id: WF } })]);
      expect(rows[5].after_json.actions.map((x) => x.id)).toEqual([h.id]);
      // redaction: in the log, never in the row
      const logText = rows.map((x) => JSON.stringify([x.before_json, x.after_json])).join('\n');
      expect(logText).not.toContain('SECRET-TOKEN');
      expect(logText).not.toContain(SECRET_HEADER);
      expect(logText).not.toContain('rotated');
      expect(rows[2].after_json.actions.find((x) => x.id === h.id).config)
        .toEqual({ url: '[redacted — host hooks.example.com]', method: 'POST', headers: { 'X-Static-Secret': '[redacted]' } });
      const [[hRow]] = await pool.query(`SELECT config FROM ${T[ch].actions} WHERE id = ?`, [h.id]);
      expect(hRow.config.headers['X-Static-Secret']).toBe('rotated');

      // duplicate: logged on the COPY; the source is untouched
      const dup = await SVC[ch].duplicateRule(pool, r.id, 2, opts);
      expect(await stampMs(ch, r.id)).toBe(s5);
      const [dc] = await changes(ch, dup.id);
      expect(dc).toMatchObject({ change_kind: 'duplicate', duplicated_from_rule_id: r.id, before_json: null });
      expect(dc.after_json.actions.map((x) => x.name)).toEqual(['vendor']);
      expect(+dc.definition_updated_at).toBe(+dup.definition_updated_at);

      // delete: the row keeps the rule and its actions; it outlives the rule (no FK)
      await SVC[ch].deleteRule(pool, r.id, opts);
      expect(await ruleRow(ch, r.id)).toBeUndefined();
      const after = await changes(ch, r.id);
      const del = after[after.length - 1];
      expect(del).toMatchObject({ change_kind: 'delete', after_json: null, definition_updated_at: null });
      expect(del.before_json.rule).toMatchObject({ id: r.id });
      expect(del.before_json.actions.map((x) => x.id)).toEqual([h.id]);
    });

    // ── (c) same transaction ────────────────────────────────────────────
    function faultyDb({ failOn = null, failCommit = false }) {
      const seen = [];
      return {
        seen,
        query: (sql, p) => pool.query(sql, p),
        getConnection: async () => {
          const c = await pool.getConnection();
          return {
            query: async (sql, p) => {
              const s = typeof sql === 'string' ? sql : sql.sql;
              seen.push(s);
              if (failOn && failOn.test(s)) throw new Error('INJECTED: statement failed');
              return c.query(sql, p);
            },
            beginTransaction: () => c.beginTransaction(),
            commit: async () => { if (failCommit) throw new Error('INJECTED: commit failed'); return c.commit(); },
            rollback: () => c.rollback(),
            release: () => c.release(),
            destroy: () => c.destroy(),
          };
        },
      };
    }

    test('(c) a failure AFTER the log insert (the commit) rolls the edit and the log row back together', async () => {
      await reset(ch);
      const r = await newRule(ch);
      const before = await snapshot(ch);
      const db = faultyDb({ failCommit: true });
      await expect(SVC[ch].updateRule(db, r.id, { name: 'never lands' }, 2)).rejects.toThrow('INJECTED: commit failed');
      expect(db.seen.some((s) => new RegExp(`INSERT INTO ${T[ch].changes}`).test(s))).toBe(true);  // the log row WAS inserted
      expect(await snapshot(ch)).toEqual(before);
      const db2 = faultyDb({ failCommit: true });
      await expect(SVC[ch].addAction(db2, r.id, { action_type: 'workflow', config: { workflow_id: WF } })).rejects.toThrow('INJECTED');
      expect(await snapshot(ch)).toEqual(before);
    });

    test('(c) a failed log insert rolls the edit back', async () => {
      await reset(ch);
      const r = await newRule(ch);
      const before = await snapshot(ch);
      for (const call of [
        (db) => SVC[ch].updateRule(db, r.id, { name: 'never lands' }, 2),
        (db) => SVC[ch].addAction(db, r.id, { action_type: 'workflow', config: { workflow_id: WF } }),
        (db) => SVC[ch].deleteRule(db, r.id),
        (db) => SVC[ch].duplicateRule(db, r.id, 2),
        (db) => SVC[ch].createRule(db, { name: 'never', match_mode: 'conditions', match_config: ALWAYS }, 2),
      ]) {
        const db = faultyDb({ failOn: new RegExp(`INSERT INTO ${T[ch].changes}`) });
        await expect(call(db)).rejects.toThrow('INJECTED: statement failed');
        expect(await snapshot(ch)).toEqual(before);
      }
    });

    // ── (d) the precondition ────────────────────────────────────────────
    test('(d) a stale expected_base is a 409 on every writer and writes nothing; the right one succeeds', async () => {
      await reset(ch);
      mockAuth = STAFF;
      const r = await newRule(ch);
      const act = await SVC[ch].addAction(pool, r.id, { action_type: 'workflow', config: { workflow_id: WF } });
      const read = async () => (await srv.send('GET', `${base}/rules/${r.id}`)).body.rule.definition_updated_at;
      const live = await read();
      const stale = new Date(Date.parse(live) - 1000).toISOString();
      const writers = [
        ['PUT rule', 'PUT', `${base}/rules/${r.id}`, { name: 'x' }],
        ['DELETE rule', 'DELETE', `${base}/rules/${r.id}`, {}],
        ['duplicate', 'POST', `${base}/rules/${r.id}/duplicate`, {}],
        ['POST action', 'POST', `${base}/rules/${r.id}/actions`, { action_type: 'workflow', config: { workflow_id: WF } }],
        ['PUT action', 'PUT', `${base}/rule-actions/${act.id}`, { name: 'x' }],
        ['DELETE action', 'DELETE', `${base}/rule-actions/${act.id}`, {}],
      ];
      for (const [label, method, p, body] of writers) {
        const before = await snapshot(ch);
        const res = await srv.send(method, p, { ...body, expected_base: { definition_updated_at: stale } });
        expect([label, res.status]).toEqual([label, 409]);
        expect(res.body).toEqual({
          error: expect.stringMatching(/changed since this edit was prepared/),
          conflict: { changed: 'definition_updated_at', expected: stale, actual: live },
        });
        expect([label, await snapshot(ch)]).toEqual([label, before]);
      }
      // the right base goes through, and returns the moved stamp
      const ok = await srv.send('PUT', `${base}/rules/${r.id}`, { name: 'fresh', expected_base: { definition_updated_at: live } });
      expect(ok.status).toBe(200);
      expect(Date.parse(ok.body.rule.definition_updated_at)).toBeGreaterThan(Date.parse(live));
      // and the old one is now stale for an ACTION write too (actions are covered by the rule stamp)
      const late = await srv.send('PUT', `${base}/rule-actions/${act.id}`, { name: 'y', expected_base: { definition_updated_at: live } });
      expect(late.status).toBe(409);
      const cur = await read();
      for (const [method, p, body, status] of [
        ['PUT', `${base}/rule-actions/${act.id}`, { name: 'y' }, 200],
        ['POST', `${base}/rules/${r.id}/actions`, { action_type: 'workflow', config: { workflow_id: WF } }, 201],
      ]) {
        const res = await srv.send(method, p, { ...body, expected_base: { definition_updated_at: await read() } });
        expect(res.status).toBe(status);
      }
      expect(Date.parse(await read())).toBeGreaterThan(Date.parse(cur));
      const dupOk = await srv.send('POST', `${base}/rules/${r.id}/duplicate`, { expected_base: { definition_updated_at: await read() } });
      expect(dupOk.status).toBe(201);
      const delA = await srv.send('DELETE', `${base}/rule-actions/${act.id}`, { expected_base: { definition_updated_at: await read() } });
      expect(delA.status).toBe(204);
      const delR = await srv.send('DELETE', `${base}/rules/${r.id}`, { expected_base: { definition_updated_at: await read() } });
      expect(delR.status).toBe(204);
    });

    test('(d) a busy rule: a match between the read and the write does NOT make the base stale', async () => {
      await reset(ch);
      mockAuth = STAFF;
      const r = await newRule(ch, { active: 1 });
      const live = (await srv.send('GET', `${base}/rules/${r.id}`)).body.rule.definition_updated_at;
      const updBefore = +(await ruleRow(ch, r.id)).updated_at;
      await new Promise((res) => setTimeout(res, 1100));                       // updated_at is whole seconds
      await SVC[ch].evaluateRules(pool, envelope(ch));
      await waitFor(async () => (await ruleRow(ch, r.id)).match_count === 1);
      expect(+(await ruleRow(ch, r.id)).updated_at).toBeGreaterThan(updBefore); // an updated_at guard would now refuse
      const res = await srv.send('PUT', `${base}/rules/${r.id}`, { description: 'reviewed', expected_base: { definition_updated_at: live } });
      expect(res.status).toBe(200);
    });

    test('(d) a malformed expected_base is a 400 with nothing written; the code gate still answers first', async () => {
      await reset(ch);
      mockAuth = STAFF;
      const r = await newRule(ch);
      const before = await snapshot(ch);
      for (const eb of [
        'x', null, [], {}, { definition_updated_at: '2026-10-27 12:00:00' }, { definition_updated_at: 1761566400000 },
        { definition_updated_at: '2026-10-27T12:00:00Z', draft_version: 1 },
      ]) {
        const res = await srv.send('PUT', `${base}/rules/${r.id}`, { name: 'x', expected_base: eb });
        expect([JSON.stringify(eb), res.status, res.body.field]).toEqual([JSON.stringify(eb), 400, 'expected_base']);
      }
      expect(await snapshot(ch)).toEqual(before);
      // staff + a code body + a stale base: the gate's 403, not a 409
      const gated = await srv.send('PUT', `${base}/rules/${r.id}`,
        { match_mode: 'code', match_config: { code: 'return true;' }, expected_base: { definition_updated_at: '2020-01-01T00:00:00.000Z' } });
      expect(gated.status).toBe(403);
      expect(gated.body.missingCapability).toBe('automations.manage');
      expect(await snapshot(ch)).toEqual(before);
    });

    test('(d) two writers racing on one base: exactly one wins, the other is a 409', async () => {
      await reset(ch);
      mockAuth = STAFF;
      const r = await newRule(ch);
      const live = (await srv.send('GET', `${base}/rules/${r.id}`)).body.rule.definition_updated_at;
      const [x, y] = await Promise.all([
        srv.send('PUT', `${base}/rules/${r.id}`, { name: 'writer A', expected_base: { definition_updated_at: live } }),
        srv.send('PUT', `${base}/rules/${r.id}`, { name: 'writer B', expected_base: { definition_updated_at: live } }),
      ]);
      expect([x.status, y.status].sort()).toEqual([200, 409]);
      const winner = x.status === 200 ? 'writer A' : 'writer B';
      expect((await ruleRow(ch, r.id)).name).toBe(winner);
      expect((await changes(ch, r.id)).map((c) => c.change_kind)).toEqual(['create', 'update']);
    });
  });
});
