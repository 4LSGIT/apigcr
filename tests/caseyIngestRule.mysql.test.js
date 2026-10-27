'use strict';
/**
 * tests/caseyIngestRule.mysql.test.js
 *
 * A20.2 / A20.3 on a REAL MySQL engine, both channels, END TO END:
 *   the real read surface (automation.definition) → the evidence Casey cites
 *   → the real normalizer (its SQL predicates on real row types) → the
 *   browser's fixed request builder, run out of public/assistant.html → the
 *   real router (routes/api.{email,phone}Ingest.js) over the real pool → the
 *   rows on disk and the change log.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * One fresh throwaway *_test database loaded from ref/database.sql plus the
 * zoneinfo tables, --runInBand. Run 2026-10-27 on MySQL 8.4.11:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a20s2_e2e_test npx jest tests/caseyIngestRule.mysql.test.js --runInBand
 * beforeAll applies scripts/ingestRuleEditStampAndChangeLog.js (A20 slice 1;
 * a no-op once ref/database.sql carries it). The suite DELETEs and re-seeds
 * the ingest rule / action / change tables, request_idempotency, and the
 * workflow / sequence / hook / sender rows it targets. Refuses port 3306.
 *
 * WHAT IS LOCKED
 *   - create: the browser posts exactly the normalized rule + actions with
 *     active 0 — and the stored row IS inactive although the column defaults
 *     to 1; the actions land in the same transaction and the 'create' log row
 *     carries them; the draft_id as Idempotency-Key replays (one rule, not
 *     two); a refused inline reference rolls the whole create back;
 *   - every edit kind: expected_base comes from the read surface's rule row,
 *     the builder sends it, the route applies it, the stamp moves and the log
 *     records the change; re-applying the SAME (now stale) card is the
 *     structured 409 with nothing written — the rendering the card refuses on;
 *     the GET the click-time precheck reads returns the same instant;
 *   - code mode reaches the route and the route's ingest code gate decides:
 *     403 for plain staff (nothing written), applied for automations.manage;
 *   - the read surface: definition_updated_at on the rule row, the change log
 *     as field-level 'change' rows.
 *   No action is ever dispatched: actionDispatchers.dispatch and
 *   hookService.executeHook are tripwires.
 */

process.env.EMAIL_DOMAINS = '4lsg.com';

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

let mockAuth = null;
jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = mockAuth; next(); }));

const STAFF = { type: 'jwt', userId: 2, username: 'staff', roles: ['staff'] };
const ADMIN = { type: 'jwt', userId: 6, username: 'it', roles: ['it', 'staff'] };

maybe('Casey ingest-rule authoring end to end on real MySQL', () => {
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const express = require('express');
  const mysql = require('mysql2/promise');
  const { withTransaction } = require('../lib/withTransaction');
  const changeLog = require('../services/ingestRuleChangeLog');
  const migration = require('../scripts/ingestRuleEditStampAndChangeLog');
  const actionDispatchers = require('../lib/actionDispatchers');
  const hookService = require('../services/hookService');
  const automation = require('../services/automationReadService');
  const svc = require('../services/assistantService');
  const T = changeLog.CHANNELS;
  const ROUTER = { email: () => require('../routes/api.emailIngest'), phone: () => require('../routes/api.phoneIngest') };

  // The browser builder, out of the page's own source.
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  function fnSrc(name) {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
    let parens = 0; let i = m.index + m[0].length - 1;
    for (; i < html.length; i++) { if (html[i] === '(') parens++; else if (html[i] === ')' && --parens === 0) break; }
    let depth = 0;
    for (let j = html.indexOf('{', i); j < html.length; j++) {
      if (html[j] === '{') depth++; else if (html[j] === '}' && --depth === 0) return html.slice(m.index, j + 1);
    }
    throw new Error(name);
  }
  function constSrc(name) {
    const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
    let depth = 0;
    for (let i = m.index; i < html.length; i++) {
      const c = html[i];
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ';' && depth === 0) return html.slice(m.index, i + 1);
    }
    throw new Error(name);
  }
  const B = new Function([constSrc('INGEST_RULE_PATHS'), constSrc('INGEST_RULE_UPDATE_FIELDS'), constSrc('INGEST_ACTION_UPDATE_FIELDS'),
    fnSrc('ingestRulePath'), fnSrc('ingestRuleId'), fnSrc('ingestRuleRequest'), fnSrc('ingestRuleResult'),
    'return { ingestRuleRequest, ingestRuleResult };'].join('\n'))(); // eslint-disable-line no-new-func

  let pool;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const servers = {};

  async function mount(router) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(router);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const send = ({ method, path: p, body }, headers = {}) => new Promise((resolve, reject) => {
      const data = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: p, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', reject);
      req.end(data);
    });
    return { send, close: () => new Promise((r) => server.close(r)) };
  }

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

    for (const ch of ['email', 'phone']) {
      await q(`DELETE FROM ${T[ch].rules}`);
      await q(`DELETE FROM ${T[ch].changes}`);
    }
    await q('DELETE FROM request_idempotency');
    // request_idempotency.user_id references users.user (the two actors below).
    await q("INSERT INTO users (user, username, user_name, user_auth, user_type) VALUES (2, 'staff', 'Staff', 'authorized', 1), (6, 'it', 'IT', 'authorized', 1) ON DUPLICATE KEY UPDATE username = VALUES(username)");
    await q("INSERT INTO workflows (id, name, active, current_version) VALUES (24, 'Court deadlines', 1, 3), (61, 'Draft only', 1, 0) ON DUPLICATE KEY UPDATE active = VALUES(active), current_version = VALUES(current_version)");
    await q("INSERT INTO sequence_templates (id, name, type, active, current_version) VALUES (5, 'No-show chase', 'no_show', 1, 1) ON DUPLICATE KEY UPDATE active = 1");
    await q("INSERT INTO hooks (id, slug, name, active) VALUES (7, 'court-relay', 'Court relay', 1), (8, 'old-relay', 'Old relay', 0) ON DUPLICATE KEY UPDATE active = VALUES(active)");
    await q("INSERT INTO email_credentials (id, email, smtp_host, smtp_port, smtp_user, smtp_pass, from_name) VALUES (3, 'automations@4lsg.com', 'h', 465, 'u', 'p', 'Automations') ON DUPLICATE KEY UPDATE email = VALUES(email)"); // secret-scan: allow
    await q("INSERT INTO credentials (id, name, type, config) VALUES (1, 'Quo test', 'bearer', '{}') ON DUPLICATE KEY UPDATE name = VALUES(name)");
    await q("INSERT INTO phone_lines (id, phone_number, provider, display_name, active, credential_id) VALUES (6, '2486213656', 'quo', 'Main', 1, 1) ON DUPLICATE KEY UPDATE active = 1");
    servers.email = await mount(ROUTER.email());
    servers.phone = await mount(ROUTER.phone());
  });

  afterAll(async () => {
    try {
      expect(actionDispatchers.dispatch).not.toHaveBeenCalled();
      expect(hookService.executeHook).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      for (const s of Object.values(servers)) await s.close();
      if (pool) await pool.end();
    }
  });

  const ruleRow = async (ch, id) => (await q(`SELECT * FROM ${T[ch].rules} WHERE id = ?`, [id]))[0];
  const actionRows = (ch, id) => q(`SELECT id, name, position, active, action_type, config FROM ${T[ch].actions} WHERE rule_id = ? ORDER BY position, id`, [id]);
  const changes = (ch, id) => q(`SELECT * FROM ${T[ch].changes} WHERE rule_id = ? ORDER BY id`, [id]);
  const snapshot = async (ch) => {
    const out = {};
    for (const t of [T[ch].rules, T[ch].actions, T[ch].changes]) out[t] = JSON.stringify(await q(`SELECT * FROM ${t} ORDER BY id`));
    return out;
  };
  // What Casey's investigation hands the normalizer: the real projection,
  // compacted exactly as executeReadStep compacts it.
  async function evidenceFor(ch, id) {
    const rows = await automation.definition(pool, { [`${ch}_ingest_rule_id`]: id });
    return [{ id: 'q1', kind: 'automation.definition', purpose: 'read the rule', rows: svc.compactRows(rows) }];
  }
  const REF = [{ query_id: 'q1', row_number: 1 }];
  const key = (ch) => `${ch}_ingest_rule_id`;
  async function apply(ch, draft, auth = STAFF) {
    mockAuth = auth;
    const req = B.ingestRuleRequest(draft);
    return servers[ch].send(req, req.idempotent ? { 'idempotency-key': draft.draft_id } : {});
  }

  describe.each(['email', 'phone'])('%s', (ch) => {
    const cond = ch === 'email'
      ? { operator: 'and', conditions: [{ path: 'from.email', op: 'equals', value: 'notices@court.gov' }, { path: 'subject', op: 'contains', value: 'Hearing' }] }
      : { operator: 'and', conditions: [{ path: 'type', op: 'equals', value: 'sms' }, { path: 'message', op: 'contains', value: 'Clio login code' }] };
    let ruleId;

    test('create: born INACTIVE with its actions in one transaction, idempotent on the draft_id', async () => {
      const draft = await svc.normalizeActionDraft(pool, {
        kind: 'ingest_rule.create.v1', channel: ch, name: `${ch} casey rule`, description: 'from Casey', position: 4,
        match_mode: 'conditions', match_config: cond,
        transform_mode: 'mapper', transform_config: [{ to: 'subject_line', from: ch === 'email' ? 'subject' : 'message', transforms: ['trim'] }],
        actions: [
          { action_type: 'workflow', name: 'Deadlines', config: { workflow_id: 24 } },
          { action_type: 'internal_function', config: { function_name: 'send_email',
            params_mapping: { from: "'automations@4lsg.com'", to: "'staff@4lsg.com'", subject: 'subject_line', text: "'see the rule'" } } },
        ], evidence: [] }, []);
      const res = await apply(ch, draft);
      expect(res.status).toBe(201);
      ruleId = res.body.rule.id;
      expect(B.ingestRuleResult(draft, res.body)).toEqual({ ingest_rule_id: ruleId });
      const row = await ruleRow(ch, ruleId);
      expect(row).toMatchObject({ name: `${ch} casey rule`, description: 'from Casey', active: 0, position: 4,
        match_mode: 'conditions', match_config: cond, transform_mode: 'mapper', last_modified_by: 2 });
      expect(await actionRows(ch, ruleId)).toEqual([
        expect.objectContaining({ name: 'Deadlines', position: 0, active: 1, action_type: 'workflow', config: { workflow_id: 24 } }),
        expect.objectContaining({ name: null, position: 1, active: 1, action_type: 'internal_function',
          config: draft.actions[1].config }),
      ]);
      const [c] = await changes(ch, ruleId);
      expect(c).toMatchObject({ change_kind: 'create', actor_user_id: 2, actor_label: 'staff' });
      expect(c.after_json.actions.map((a) => a.action_type)).toEqual(['workflow', 'internal_function']);
      // The same card applied again (a second tab, a retry after a timeout): replayed, not re-created.
      const again = await apply(ch, draft);
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ replayed: true, rule: { id: ruleId } });
      expect((await q(`SELECT COUNT(*) AS n FROM ${T[ch].rules} WHERE name = ?`, [`${ch} casey rule`]))[0].n).toBe(1);
    });

    test('a refused inline reference rolls the whole create back (nothing half-created)', async () => {
      mockAuth = STAFF;
      const before = await snapshot(ch);
      const res = await servers[ch].send({ method: 'POST', path: `/api/${ch}-ingest/rules`, body: {
        name: 'half', active: 0, match_mode: 'conditions', match_config: cond,
        actions: [{ action_type: 'workflow', config: { workflow_id: 24 } }, { action_type: 'hook', config: { slug: 'old-relay' } }] } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'validation_failed', field: 'actions[1].config.slug' });
      expect(await snapshot(ch)).toEqual(before);
    });

    test('update: the base is the read surface\'s stamp; applied once, the same card is then a 409 that writes nothing', async () => {
      const evidence = await evidenceFor(ch, ruleId);
      // compactRows hands the model strings — the normalizer compares numerically.
      expect(evidence[0].rows[0]).toMatchObject({ row: 'rule', [key(ch)]: String(ruleId) });
      expect(evidence[0].rows[0].definition_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const draft = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.update.v1', [key(ch)]: ruleId,
        changes: { name: `${ch} casey rule v2`, match_mode: 'conditions',
          match_config: { operator: 'or', conditions: cond.conditions } }, evidence: REF }, evidence);
      expect(draft.expected_base).toEqual({ definition_updated_at: evidence[0].rows[0].definition_updated_at });
      expect(draft.live).toBe(0);
      // The GET the browser's click-time precheck reads returns the SAME instant.
      mockAuth = STAFF;
      const got = await servers[ch].send({ method: 'GET', path: `/api/${ch}-ingest/rules/${ruleId}` });
      expect(Date.parse(got.body.rule.definition_updated_at)).toBe(Date.parse(draft.expected_base.definition_updated_at));

      const s0 = +(await ruleRow(ch, ruleId)).definition_updated_at;
      const res = await apply(ch, draft);
      expect(res.status).toBe(200);
      expect(B.ingestRuleResult(draft, res.body)).toEqual({ ingest_rule_id: ruleId });
      const row = await ruleRow(ch, ruleId);
      expect(row).toMatchObject({ name: `${ch} casey rule v2`, match_config: { operator: 'or', conditions: cond.conditions } });
      expect(+row.definition_updated_at).toBeGreaterThan(s0);
      expect((await changes(ch, ruleId)).map((c) => c.change_kind)).toEqual(['create', 'update']);

      const before = await snapshot(ch);
      const stale = await apply(ch, draft);
      expect(stale.status).toBe(409);
      expect(stale.body.conflict).toMatchObject({ changed: 'definition_updated_at', expected: draft.expected_base.definition_updated_at });
      expect(await snapshot(ch)).toEqual(before);
    });

    test('the read surface carries the change log as field-level change rows', async () => {
      const rows = await automation.definition(pool, { [key(ch)]: ruleId });
      const ch1 = rows.filter((r) => r.row === 'change');
      expect(ch1.map((c) => c.change_kind)).toEqual(['update', 'create']);
      const diff = JSON.parse(ch1[0].diff);
      expect(diff).toEqual(expect.arrayContaining([
        { field: 'name', before: JSON.stringify(`${ch} casey rule`), after: JSON.stringify(`${ch} casey rule v2`) },
        expect.objectContaining({ field: 'match_config' }),
      ]));
      expect(ch1[0]).toMatchObject({ actor: 'staff', [key(ch)]: ruleId });
      expect(ch1[0].changed_at).toMatch(/\(America\/Detroit\)$/);
    });

    test('action add / update / remove through the routes, each guarded, each logged', async () => {
      let evidence = await evidenceFor(ch, ruleId);
      const add = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.action_add.v1', [key(ch)]: ruleId,
        action: { action_type: 'sequence', name: 'Chase', config: { template_id: 5, contact_id_field: 'contact_id' } }, evidence: REF }, evidence);
      const added = await apply(ch, add);
      expect(added.status).toBe(201);
      expect(B.ingestRuleResult(add, added.body)).toEqual({ ingest_rule_id: ruleId });
      const newId = added.body.action.id;

      evidence = await evidenceFor(ch, ruleId);
      const upd = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.action_update.v1', [key(ch)]: ruleId, rule_action_id: newId,
        changes: { name: 'Chase (paused)', active: false }, evidence: REF }, evidence);
      const updated = await apply(ch, upd);
      expect(updated.status).toBe(200);
      expect((await actionRows(ch, ruleId)).find((a) => a.id === newId)).toMatchObject({ name: 'Chase (paused)', active: 0 });

      evidence = await evidenceFor(ch, ruleId);
      const rm = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.action_remove.v1', [key(ch)]: ruleId, rule_action_id: newId, evidence: REF }, evidence);
      const req = B.ingestRuleRequest(rm);
      mockAuth = STAFF;
      const removed = await servers[ch].send(req);
      expect(removed).toEqual({ status: 204, body: null });
      expect((await actionRows(ch, ruleId)).some((a) => a.id === newId)).toBe(false);
      // A card built on an older base (the add, re-applied) refuses — 409, nothing written.
      const before = await snapshot(ch);
      expect((await apply(ch, { ...add, draft_id: require('crypto').randomUUID() })).status).toBe(409);
      expect(await snapshot(ch)).toEqual(before);
      expect((await changes(ch, ruleId)).map((c) => c.change_kind)).toEqual(['create', 'update', 'action_add', 'action_update', 'action_delete']);
    });

    test('activate, then an ACTIVE-rule edit is marked live; deactivate', async () => {
      let evidence = await evidenceFor(ch, ruleId);
      const on = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.set_active.v1', [key(ch)]: ruleId, active: true, evidence: REF }, evidence);
      expect(on.impact[0]).toMatch(/STARTS PROCESSING LIVE TRAFFIC/);
      expect((await apply(ch, on)).status).toBe(200);
      expect((await ruleRow(ch, ruleId)).active).toBe(1);

      evidence = await evidenceFor(ch, ruleId);
      const live = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.update.v1', [key(ch)]: ruleId,
        changes: { position: 9 }, evidence: REF }, evidence);
      expect(live.live).toBe(1);
      expect(live.live_text).toMatch(/applies to the very next matching/);
      expect((await apply(ch, live)).status).toBe(200);

      evidence = await evidenceFor(ch, ruleId);
      const off = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.set_active.v1', [key(ch)]: ruleId, active: false, evidence: REF }, evidence);
      expect((await apply(ch, off)).status).toBe(200);
      expect((await ruleRow(ch, ruleId)).active).toBe(0);
      const kinds = (await changes(ch, ruleId)).map((c) => c.change_kind);
      expect(kinds.slice(-3)).toEqual(['activate', 'update', 'deactivate']);
    });

    test('forwards: the live shape applies end to end; staff vs outside classified on real rows; an opted-out destination refused', async () => {
      await q("UPDATE users SET email = 'staff@4lsg.example', phone = '2485550142' WHERE user = 2");
      await q("INSERT INTO contacts (contact_id, contact_fname, contact_lname) VALUES (4401, 'Pat', 'Client') ON DUPLICATE KEY UPDATE contact_fname = VALUES(contact_fname)");
      await q("DELETE FROM contact_emails WHERE contact_id = 4401");
      await q("INSERT INTO contact_emails (contact_id, email, email_optout) VALUES (4401, 'pat.optout@example.com', 1)");
      const value = (to, fn = 'forward_as_email') => ({ kind: 'ingest_rule.create.v1', channel: ch, name: `${ch} forward ${to}`,
        match_mode: 'conditions', match_config: cond, transform_mode: 'passthrough', evidence: [],
        actions: [{ action_type: 'internal_function', config: { function_name: fn, params_mapping: fn === 'forward_as_email'
          ? { event: '$', from: "'automations@4lsg.com'", to: `'${to}'`, subject_prefix: "'Fwd: '" }
          : { event: '$', from: "'2486213656'", to: `'${to}'`, body_prefix: "'ALERT: '" } } }] });
      const staff = await svc.normalizeActionDraft(pool, value('staff@4lsg.example'), []);
      expect(staff.actions[0].summary).toMatch(/to staff@4lsg\.example \(firm \/ staff\)/);
      const staffSms = await svc.normalizeActionDraft(pool, value('248-555-0142', 'forward_as_sms'), []);
      expect(staffSms.actions[0].summary).toMatch(/to 2485550142 \(firm \/ staff\)/);
      const outside = await svc.normalizeActionDraft(pool, value('someone@example.org'), []);
      expect(outside.actions[0].summary).toMatch(/someone@example\.org — OUTSIDE THE FIRM/);
      await expect(svc.normalizeActionDraft(pool, value('pat.optout@example.com'), [])).rejects.toThrow(/has opted out of email/);
      // send_email / send_sms to a LITERAL destination: the same classifier and
      // opt-out lookup on the same real rows (Fable review #3).
      const sendValue = (to, fn = 'send_email') => ({ ...value(to), name: `${ch} send ${to}`,
        actions: [{ action_type: 'internal_function', config: { function_name: fn, params_mapping: fn === 'send_email'
          ? { from: "'automations@4lsg.com'", to: `'${to}'`, subject: "'s'", text: "'t'" }
          : { from: "'2486213656'", to: `'${to}'`, message: "'m'" } } }] });
      expect((await svc.normalizeActionDraft(pool, sendValue('staff@4lsg.example'), [])).actions[0].summary).toMatch(/^calls send_email to staff@4lsg\.example \(firm \/ staff\)/);
      expect((await svc.normalizeActionDraft(pool, sendValue('248-555-0142', 'send_sms'), [])).actions[0].summary).toMatch(/^calls send_sms to 2485550142 \(firm \/ staff\)/);
      expect((await svc.normalizeActionDraft(pool, sendValue('someone@example.org'), [])).actions[0].summary).toMatch(/^calls send_email to someone@example\.org — OUTSIDE THE FIRM/);
      await expect(svc.normalizeActionDraft(pool, sendValue('pat.optout@example.com'), [])).rejects.toThrow(/send destination pat\.optout@example\.com has opted out of email/);
      const res = await apply(ch, staff);
      expect(res.status).toBe(201);
      const [a] = await actionRows(ch, res.body.rule.id);
      expect(a).toMatchObject({ action_type: 'internal_function', active: 1, config: staff.actions[0].config });
    });

    test('CODE mode: the route\'s ingest code gate decides — 403 for plain staff (nothing written), applied for automations.manage', async () => {
      const draft = await svc.normalizeActionDraft(pool, { kind: 'ingest_rule.create.v1', channel: ch, name: `${ch} code rule`,
        match_mode: 'code', match_config: { code: 'return String(input.subject || input.message || "").includes("341");' },
        transform_mode: 'passthrough', evidence: [] }, []);
      expect(draft.requires_capability).toBe('automations.manage');
      const before = await snapshot(ch);
      const refused = await apply(ch, draft, STAFF);
      expect(refused.status).toBe(403);
      expect(refused.body.missingCapability).toBe('automations.manage');
      expect(await snapshot(ch)).toEqual(before);
      expect((await q('SELECT COUNT(*) AS n FROM request_idempotency WHERE idem_key = ?', [draft.draft_id]))[0].n).toBe(0);
      const ok = await apply(ch, draft, ADMIN);
      expect(ok.status).toBe(201);
      expect(await ruleRow(ch, ok.body.rule.id)).toMatchObject({ active: 0, match_mode: 'code', match_config: draft.rule.match_config });
    });
  });
});
