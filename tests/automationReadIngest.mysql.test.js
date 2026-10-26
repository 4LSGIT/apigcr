'use strict';
/**
 * tests/automationReadIngest.mysql.test.js
 *
 * A20.0 / A20.1 — Casey's ingest-rule reads and the dry-run preview, on a REAL
 * MySQL engine (projection SQL, mysql2 row types — JSON columns arrive parsed,
 * DATETIMEs as Date — MEMBER OF with a numeric bind, firm-local windows).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 * The gated-suite protocol (tests/mailboxS2.mysql.test.js header): ONE fresh
 * throwaway *_test database loaded from ref/database.sql plus the zoneinfo
 * tables, --runInBand. Run 2026-10-26 on MySQL 8.4.11:
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3361/yc_a20_test npx jest tests/automationReadIngest.mysql.test.js --runInBand
 * The suite DELETEs and re-seeds the ingest, workflow, sequence, hook and
 * credential tables it uses, and creates the MySQL user a20_ro.
 * beforeAll applies scripts/ingestRuleEditStampAndChangeLog.js (A20 slice 1 —
 * the rule CRUD now reads definition_updated_at); a no-op once the dump has it.
 *
 * WHAT IS LOCKED
 *   - Redaction: an `http` action's URL and literal header values never reach
 *     any read or preview row (host, method, credential label do); code bodies
 *     are readable, in parts, whole.
 *   - email_ingest_sources (live keys) is never touched: every read and the
 *     preview run as a MySQL user with NO grant on it (and column-only grants
 *     on credentials / hooks), so a query naming it fails, not just leaks.
 *   - The preview writes NOTHING: a full row snapshot of every table it could
 *     reach is identical before and after a full matrix run on a pool that COULD
 *     write, and no INSERT/UPDATE/DELETE statement was issued.
 *   - Semantics, from the engine: a throwing match is a non-match with the
 *     reason surfaced; NULL conditions = non-match; a failed transform =
 *     matched, no action; firm-to-firm ran Layer 3; a duplicate ran nothing;
 *     email `body` is derived as evaluateRules derives it (and the native
 *     tester's divergence on a full-fidelity row is pinned as found).
 *   - A20.2's trace item: an action write (add/update/delete) does NOT move the
 *     parent rule's updated_at; a match-count bump DOES.
 */

const URL_ = process.env.YC_TEST_MYSQL_URL;
const maybe = URL_ ? describe : describe.skip;
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

const SECRET_URL = 'https://hooks.example.com/t/SECRET-TOKEN-abc123';
const SECRET_HEADER = 'literal-header-SECRET-value';
const SOURCE_KEY = 'test-not-a-key-SOURCESECRET'; // secret-scan: allow

// The reads and the preview may touch only these. email_ingest_sources is
// deliberately absent; credentials / hooks are column-granted.
const RO_TABLES = ['email_ingest_rules', 'email_ingest_rule_actions', 'email_ingest_executions',
  'email_ingest_log_suppressions', 'email_log', 'log', 'phone_ingest_rules', 'phone_ingest_rule_actions',
  'phone_ingest_executions', 'phone_log_suppressions', 'phone_event_log', 'workflows', 'sequence_templates',
  'hook_targets', 'trigger_rule_actions', 'trigger_rules', 'sequence_steps', 'workflow_steps', 'cta_links'];
const CHECKSUM_TABLES = [...RO_TABLES, 'hooks', 'credentials', 'email_ingest_sources', 'scheduled_jobs',
  'workflow_executions', 'sequence_enrollments', 'hook_executions'];

const LONG_CODE = `// docs digest\n${'/* pad */ '.repeat(1070)}\nreturn { digest: input.subject, contact_id: 1 };`;

maybe('Casey ingest reads + preview on real MySQL', () => {
  const mysql = require('mysql2/promise');
  const automation = require('../services/automationReadService');
  const preview = require('../services/ingestRulePreviewService');
  const ruleService = require('../services/emailIngestRuleService');
  const actionDispatchers = require('../lib/actionDispatchers');
  const hookService = require('../services/hookService');

  let root;
  let ro;
  const statements = [];
  const q = async (sql, p) => (await root.query(sql, p))[0];
  // The service's db contract is { query }; record every statement it issues.
  const recorded = (pool) => ({
    query: (sql, params) => { statements.push(String(sql)); return pool.query(sql, params); },
  });

  beforeAll(async () => {
    const u = new URL(URL_);
    const database = u.pathname.replace(/^\//, '');
    if (!/_test$/.test(database)) throw new Error(`YC_TEST_MYSQL_URL must name a throwaway *_test database (got "${database}")`);
    if (Number(u.port) === 3306) throw new Error('port 3306 is the production proxy — refusing');
    const conn = { host: u.hostname, port: Number(u.port), database, timezone: 'Z', connectionLimit: 3 };
    root = mysql.createPool({ ...conn, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    root.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    // A20 slice 1: the rule services read definition_updated_at and write the
    // change tables. Idempotent — ALREADY APPLIED once ref/database.sql carries it.
    {
      const mc = await root.getConnection();
      try {
        const r = await require('../scripts/ingestRuleEditStampAndChangeLog').run(mc, { apply: true, log: () => {} });
        if (!r.ok) throw new Error(`ingest edit-stamp migration did not apply: ${r.line}`);
      } finally { mc.release(); }
    }

    // Dependents first (a dispatch that ever escaped the tripwires below would
    // leave rows here holding FKs on workflows).
    for (const t of ['scheduled_jobs', 'workflow_execution_steps', 'workflow_executions', 'ai_calls']) await q(`DELETE FROM ${t}`);
    for (const t of ['email_ingest_rule_actions', 'email_ingest_rules', 'email_ingest_executions', 'email_log',
      'email_ingest_log_suppressions', 'email_ingest_sources', 'phone_ingest_rule_actions', 'phone_ingest_rules',
      'phone_ingest_executions', 'phone_event_log', 'phone_log_suppressions', 'workflows', 'sequence_templates',
      'hooks', 'credentials']) await q(`DELETE FROM ${t}`);

    await q(`INSERT INTO email_ingest_sources (id, name, api_key, active) VALUES (1, 'gmail-firm', ?, 1)`, [SOURCE_KEY]);
    await q(`INSERT INTO workflows (id, name, active, current_version) VALUES
      (24, 'Court deadlines', 1, 3), (25, 'Retired flow', 0, 1), (26, 'Never published', 1, 0)`);
    await q(`INSERT INTO sequence_templates (id, name, type, active, current_version) VALUES
      (5, 'No-show chase', 'no_show', 1, 1), (6, 'Other', 'welcome', 1, 1)`);
    await q(`INSERT INTO hooks (id, slug, name, active) VALUES (7, 'court-relay', 'Court relay', 0)`);
    await q(`INSERT INTO credentials (id, name, type, config) VALUES (3, 'Clio OAuth', 'oauth2', '{"client_secret":"CRED-SECRET"}')`);

    const always = JSON.stringify({ operator: 'and', conditions: [] });
    const rule = (id, name, active, position, matchMode, match, transformMode, transform) =>
      q(`INSERT INTO email_ingest_rules (id, name, active, position, match_mode, match_config, transform_mode, transform_config, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01 00:00:00')`,
      [id, name, active, position, matchMode, match, transformMode, transform]);
    await rule(15, 'court emails', 1, 0, 'conditions',
      JSON.stringify({ operator: 'and', conditions: [{ path: 'from.email', op: 'ends_with', value: 'uscourts.gov' }] }),
      'code', JSON.stringify({ code: "const m = String(input.subject || '').match(/\\d{2}-\\d{5}/); return { case_no: m ? m[0] : null, contact_id: 1309 };" }));
    await rule(24, 'docs digest', 1, 0, 'conditions', always, 'code', JSON.stringify({ code: LONG_CODE }));
    await rule(30, 'null match', 1, 5, 'conditions', null, 'passthrough', null);
    await rule(31, 'throwing code', 1, 5, 'code', JSON.stringify({ code: 'throw new Error("boom on " + input.subject)' }), 'passthrough', null);
    await rule(32, 'body hearing', 1, 6, 'conditions',
      JSON.stringify({ operator: 'and', conditions: [{ path: 'body', op: 'contains', value: 'hearing is set' }] }), 'passthrough', null);
    await rule(33, 'inactive', 0, 7, 'conditions', always, 'mapper', JSON.stringify([{ from: 'subject', to: 'title' }]));
    await rule(34, 'bad transform', 1, 8, 'conditions', always, 'mapper', JSON.stringify({ from: 'a' }));

    const action = (id, ruleId, name, position, active, type, config) =>
      q('INSERT INTO email_ingest_rule_actions (id, rule_id, name, position, active, action_type, config) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, ruleId, name, position, active, type, JSON.stringify(config)]);
    await action(101, 15, 'start deadlines', 0, 1, 'workflow', { workflow_id: 24 });
    await action(102, 15, 'notify vendor', 1, 1, 'http', { url: SECRET_URL, method: 'post', credential_id: 3,
      headers: { 'X-Static-Secret': SECRET_HEADER }, body_mode: 'template', body_template: '{"case":"{{case_no}}"}' });
    await action(103, 15, 'enroll', 2, 1, 'sequence', { template_type: 'no_show', contact_id_field: 'contact_id' });
    await action(104, 15, 'relay', 3, 1, 'hook', { slug: 'court-relay' });
    await action(105, 15, 'extract', 4, 1, 'internal_function', { function_name: 'court_extract', params_mapping: { case_no: 'case_no', all: '$', fixed: "'lit'" } });
    await action(106, 15, 'old flow', 5, 1, 'workflow', { workflow_id: 25 });
    await action(107, 15, 'paused', 6, 0, 'workflow', { workflow_id: 24 });
    await action(110, 24, 'digest', 0, 1, 'internal_function', { function_name: 'noop', params_mapping: {} });
    await action(130, 33, 'never', 0, 1, 'workflow', { workflow_id: 26 });

    await q(`INSERT INTO email_ingest_log_suppressions (id, name, active, match_mode, match_config) VALUES
      (1, 'Newsletters', 1, 'conditions', ?)`, [JSON.stringify({ operator: 'and', conditions: [{ path: 'subject', op: 'contains', value: 'digest' }] })]);

    const intact = {
      kind: 'email', source: 'gmail-firm', from: { email: 'ecf@mieb.uscourts.gov', name: 'MIEB' },
      to: [{ email: 'docs@4lsg.com', name: '' }], subject: 'Notice of Hearing 26-40001',
      headers: { message_id: 'm-1' }, text: 'A hearing is set for 11/3.', html: '<p>A hearing is set for 11/3.</p>',
    };
    await q(`INSERT INTO email_log (id, source, message_id, from_email, to_email, subject, body, processed_at) VALUES
      (9001, 'gmail-firm', 'm-1', 'ecf@mieb.uscourts.gov', 'docs@4lsg.com', 'Notice of Hearing 26-40001', 'A hearing is set for 11/3.', '2026-10-26 04:52:16'),
      (9002, 'gmail-firm', 'm-2', 'news@vendor.example', 'stuart@4lsg.com', 'Weekly digest', 'digest body', '2026-10-25 23:30:00'),
      (9005, 'gmail-firm', 'm-9-test-abc', 'ecf@mieb.uscourts.gov', 'docs@4lsg.com', 'Replay 26-40001', 'replayed', '2026-10-26 05:00:00')`);
    const exec = (id, status, mid, elId, meta, raw, created, error = null) =>
      q(`INSERT INTO email_ingest_executions (id, source_id, message_id, status, email_log_id, error, metadata, raw_input, remote_ip, created_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, '10.0.0.9', ?)`,
      [id, mid, status, elId, error, meta == null ? null : JSON.stringify(meta), raw == null ? null : JSON.stringify(raw), created]);
    await exec(28500, 'logged', 'm-1', 9001, { matched_rules: [15], action_outcomes: [
      { rule_id: 15, rule_action_id: 101, action_type: 'workflow', status: 'success', result: { workflow_execution_id: 777, workflow_id: 24 } },
      { rule_id: 15, rule_action_id: 102, action_type: 'http', status: 'failed', error: 'http delivery failed: 401' },
    ] }, intact, '2026-10-26 08:52:16');
    await exec(28501, 'duplicate', 'm-1', 9001, null, intact, '2026-10-26 08:53:00');
    await exec(28502, 'skipped_firm_to_firm', 'm-3', 9001, { matched_rules: [34], action_outcomes: [
      { rule_id: 34, rule_action_id: null, action_type: 'transform', status: 'failed', error: 'mapper transform_config must be an array of mapping rules' },
    ] }, intact, '2026-10-26 09:00:00');
    await exec(28503, 'skipped_suppression', 'm-2', 9002, { suppressed_by: [1] },
      { preview: '{"kind":"email"', _truncated: true, _original_size: 40000 }, '2026-10-26 03:30:00');
    await exec(28504, 'error', 'm-4', null, null, null, '2026-10-26 09:10:00', 'email_log INSERT IGNORE no-op without matching existing row');
    await exec(28505, 'logged', 'm-9-test-abc', 9005, { is_test: true, matched_rules: [15], action_outcomes: [
      { rule_id: 15, rule_action_id: 101, action_type: 'workflow', status: 'skipped_test_envelope' },
    ] }, { ...intact, subject: 'Replay 26-40001', headers: { message_id: 'm-9-test-abc' } }, '2026-10-26 09:20:00');

    await q(`INSERT INTO phone_ingest_rules (id, name, active, position, match_mode, match_config, transform_mode, transform_config) VALUES
      (3, 'Clio code', 1, 0, 'conditions', ?, 'mapper', ?)`,
    [JSON.stringify({ operator: 'and', conditions: [{ path: 'type', op: 'equals', value: 'sms' }] }), JSON.stringify([{ from: 'message', to: 'text' }])]);
    await q(`INSERT INTO phone_ingest_rule_actions (id, rule_id, name, position, active, action_type, config) VALUES
      (2, 3, 'to deadlines', 0, 1, 'workflow', '{"workflow_id": "24"}')`);
    await q(`INSERT INTO phone_event_log (id, provider, provider_ref, event_type, direction, from_number, to_number, other_party, body, processed_at) VALUES
      (500, 'quo', 'ref-1', 'sms', 'incoming', '2485550100', '3135550199', '2485550100', 'Is my hearing on?', '2026-10-26 10:00:00')`);
    const smsRaw = { type: 'sms', from: '2485550100', to: '3135550199', message: 'Is my hearing on?', extra: { firmToFirm: false } };
    await q(`INSERT INTO phone_ingest_executions (id, event_log_id, status, metadata, raw_input, created_at) VALUES
      (12201, 500, 'logged', ?, ?, '2026-10-26 10:00:01'),
      (12202, 500, 'logged', '{"automation":{"skipped":"backfill"}}', ?, '2026-10-26 10:00:02'),
      (12203, 500, 'duplicate', NULL, ?, '2026-10-26 10:00:03')`,
    [JSON.stringify({ matched_rules: [3], action_outcomes: [{ rule_id: 3, rule_action_id: 2, action_type: 'workflow', status: 'success', result: { workflow_execution_id: 9 } }] }),
      JSON.stringify(smsRaw), JSON.stringify(smsRaw), JSON.stringify(smsRaw)]);

    // The least-privilege reader: SELECT on the listed tables only, column
    // grants on credentials / hooks, NOTHING on email_ingest_sources.
    await q("DROP USER IF EXISTS 'a20_ro'@'%'");
    await q("CREATE USER 'a20_ro'@'%' IDENTIFIED BY 'a20-ro-test'"); // secret-scan: allow
    for (const t of RO_TABLES) await q(`GRANT SELECT ON \`${database}\`.\`${t}\` TO 'a20_ro'@'%'`);
    await q(`GRANT SELECT (id, name) ON \`${database}\`.credentials TO 'a20_ro'@'%'`);
    await q(`GRANT SELECT (id, slug, name, active) ON \`${database}\`.hooks TO 'a20_ro'@'%'`);
    ro = mysql.createPool({ ...conn, user: 'a20_ro', password: 'a20-ro-test' }); // secret-scan: allow
    ro.pool.on('connection', (c) => c.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
  });

  afterAll(async () => {
    if (ro) await ro.end();
    if (root) {
      await q("DROP USER IF EXISTS 'a20_ro'@'%'");
      await root.end();
    }
  });
  // TRIPWIRES. The preview must never dispatch; if a regression made it call
  // the live evaluator, these record the attempt (and stop the real side
  // effect) instead of starting workflows / calling URLs from a test run on a
  // machine whose .env reaches production services.
  const dispatched = [];
  beforeEach(() => {
    dispatched.length = 0;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(actionDispatchers, 'dispatch').mockImplementation(async (_db, type) => {
      dispatched.push(type);
      return { status: 'failed', error: 'tripwire', result: null };
    });
    jest.spyOn(hookService, 'executeHook').mockImplementation(async (_db, slug) => {
      dispatched.push(`hook:${slug}`);
      return { status: 'failed', error: 'tripwire' };
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const db = () => recorded(ro);
  const all = (rows) => JSON.stringify(rows);

  test('the least-privilege reader really cannot read email_ingest_sources or credentials.config', async () => {
    await expect(ro.query('SELECT name FROM email_ingest_sources')).rejects.toMatchObject({ code: 'ER_TABLEACCESS_DENIED_ERROR' });
    await expect(ro.query('SELECT config FROM credentials')).rejects.toMatchObject({ code: 'ER_COLUMNACCESS_DENIED_ERROR' });
  });

  test('definition: rule + action rows, real row types, http redacted, targets resolved, evaluation order', async () => {
    const rows = await automation.definition(db(), { email_ingest_rule_id: 15 });
    const text = all(rows);
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain('/t/');
    expect(text).not.toContain(SECRET_HEADER);
    expect(text).not.toContain('CRED-SECRET');
    const head = rows[0];
    expect(head).toMatchObject({ row: 'rule', email_ingest_rule_id: 15, active: true, evaluation_order: 1,
      match_mode: 'conditions', transform_mode: 'code', action_count: 7, active_action_count: 6 });
    expect(head.updated_at).toBeInstanceOf(Date);
    expect(head.transform_config).toContain('case_no');                 // code readable (ruling 9)
    expect(JSON.parse(head.match_config).conditions[0]).toEqual({ path: 'from.email', op: 'ends_with', value: 'uscourts.gov' });
    const act = (id) => rows.find((r) => r.row === 'action' && r.rule_action_id === id);
    expect(JSON.parse(act(102).config)).toMatchObject({ method: 'post', url_host: 'hooks.example.com', url_redacted: true,
      credential: 'Clio OAuth', header_keys: ['X-Static-Secret'], body_mode: 'template' });
    expect(act(102).target).toMatch(/POST to host hooks\.example\.com \[URL redacted\] using Clio OAuth/);
    expect(act(101).target).toMatch(/starts workflow 24 "Court deadlines" \(active, published v3\)/);
    expect(act(106).target).toMatch(/INACTIVE — dispatch is refused/);
    expect(act(103).target).toMatch(/type "no_show" \(5 "No-show chase"\); contact id read from .*"contact_id"/);
    expect(act(104).target).toMatch(/hook 7 "Court relay" \(slug court-relay, INACTIVE\)/);
    expect(act(107)).toMatchObject({ active: false });
    expect(rows.filter((r) => r.row === 'action').map((r) => r.rule_action_id)).toEqual([101, 102, 103, 104, 105, 106, 107]);
  });

  test('definition: a 10.7 KB code body comes back whole, in parts under the cell cap; NULL conditions is called out', async () => {
    const rows = await automation.definition(db(), { email_ingest_rule_id: 24 });
    const parts = rows.filter((r) => r.row === 'code_part');
    expect(parts.length).toBe(Math.ceil(LONG_CODE.length / automation.CODE_PART_CHARS));
    expect(parts.map((p) => p.code).join('')).toBe(LONG_CODE);
    for (const p of parts) expect(p).toMatchObject({ email_ingest_rule_id: 24, field: 'transform_config', of: parts.length });
    expect(rows[0].transform_config).toMatch(/code_part rows/);
    const nul = await automation.definition(db(), { email_ingest_rule_id: 30 });
    expect(nul[0].notes).toMatch(/NULL match_config in conditions mode never matches \(it is NOT match-all\)/);
    expect(nul[0].match_config).toBeNull();
    await expect(automation.definition(db(), { email_ingest_rule_id: 999 })).rejects.toMatchObject({ status: 404 });
  });

  test('list: rules, suppressions and the execution finder with firm-local windows', async () => {
    const rules = await automation.list(db(), { type: 'email_ingest_rules', limit: 50 });
    expect(rules.map((r) => r.email_ingest_rule_id)).toEqual([15, 24, 30, 31, 32, 33, 34]);
    expect(rules[0]).toMatchObject({ active: true, action_count: 7, active_action_count: 6 });
    expect(rules.find((r) => r.email_ingest_rule_id === 33).active).toBe(false);
    const supp = await automation.list(db(), { type: 'email_ingest_suppressions', limit: 50 });
    expect(supp[0]).toMatchObject({ email_ingest_suppression_id: 1, name: 'Newsletters', effect: expect.stringMatching(/never gates automation/) });
    // 28503 was created 03:30 UTC = 23:30 on 10-25 in Detroit: OUT of a
    // since 2026-10-26 window, IN an until 2026-10-25 one.
    const day = await automation.list(db(), { type: 'email_ingest_executions', since: '2026-10-26', limit: 50 });
    expect(day.map((r) => r.email_ingest_execution_id)).toEqual([28505, 28504, 28502, 28501, 28500]);
    const before = await automation.list(db(), { type: 'email_ingest_executions', until: '2026-10-25', limit: 50 });
    expect(before.map((r) => r.email_ingest_execution_id)).toEqual([28503]);
    expect(before[0].created_local).toBe('2026-10-25 23:30:00 (America/Detroit)');
    const court = await automation.list(db(), { type: 'email_ingest_executions', query: 'uscourts', limit: 50 });
    expect(court.map((r) => r.email_ingest_execution_id)).toEqual([28505, 28502, 28501, 28500]);
    expect(court.find((r) => r.email_ingest_execution_id === 28500)).toMatchObject({
      matched_rules: '15 "court emails"', subject: 'Notice of Hearing 26-40001', source_name: 'gmail-firm' });
    const phone = await automation.list(db(), { type: 'phone_ingest_executions', query: '2485550100', limit: 50 });
    expect(phone.map((r) => r.phone_ingest_execution_id)).toEqual([12203, 12202, 12201]);
    expect(phone[1].layer3_skipped).toBe('backfill');
  });

  test('run: where each message stopped, outcomes with meanings, the duplicate\'s original', async () => {
    const r1 = await automation.run(db(), { email_ingest_execution_id: 28500 });
    expect(r1[0]).toMatchObject({ row: 'execution', layer3: 'ran', status: 'logged', matched_rules: '15 "court emails"',
      action_failure_count: 1, feeder: 'HTTP adapter', from_email: 'ecf@mieb.uscourts.gov' });
    expect(r1[0].created_at).toBeInstanceOf(Date);
    expect(r1.find((r) => r.row === 'matched_rule')).toMatchObject({ email_ingest_rule_id: 15, rule_active_now: true });
    const fail = r1.find((r) => r.row === 'action_outcome' && r.rule_action_id === 102);
    expect(fail).toMatchObject({ action_name: 'notify vendor', status: 'failed', error: 'http delivery failed: 401' });
    expect(JSON.parse(r1.find((r) => r.rule_action_id === 101).result)).toEqual({ workflow_execution_id: 777, workflow_id: 24 });

    const dup = await automation.run(db(), { email_ingest_execution_id: 28501 });
    expect(dup[0]).toMatchObject({ layer3: 'did not run', original_execution_id: 28500 });
    expect(dup[0].pipeline).toMatch(/suppression and automation did NOT run/);
    const f2f = await automation.run(db(), { email_ingest_execution_id: 28502 });
    expect(f2f[0]).toMatchObject({ layer3: 'ran' });
    expect(f2f.find((r) => r.row === 'matched_rule').result).toMatch(/transform FAILED — none of its actions ran/);
    expect(f2f.find((r) => r.row === 'action_outcome').meaning).toMatch(/transform failed, so its actions were skipped/);
    const supp = await automation.run(db(), { email_ingest_execution_id: 28503 });
    expect(supp.find((r) => r.row === 'suppression')).toMatchObject({ email_ingest_suppression_id: 1, name: 'Newsletters' });
    expect((await automation.run(db(), { email_ingest_execution_id: 28504 }))[0]).toMatchObject({ layer3: 'unknown' });
    const replay = await automation.run(db(), { email_ingest_execution_id: 28505 });
    expect(replay[0].is_test_replay).toBe(1);
    expect(replay.find((r) => r.row === 'action_outcome').meaning).toMatch(/"-test-" replay/);

    // A rule's LATEST matching execution — MEMBER OF with a numeric bind.
    const latest = await automation.run(db(), { email_ingest_rule_id: 15 });
    expect(latest[0][automation.INGEST_LIST_TYPES.email_ingest_rules.ch.execKey]).toBe(28505);
    await expect(automation.run(db(), { email_ingest_rule_id: 33 })).rejects.toThrow(/has not matched any recorded execution/);

    const skipped = await automation.run(db(), { phone_ingest_execution_id: 12202 });
    expect(skipped[0].layer3).toBe('skipped by the caller (backfill)');
    const pdup = await automation.run(db(), { phone_ingest_execution_id: 12203 });
    expect(pdup[0]).toMatchObject({ layer3: 'did not run', original_execution_id: 12201 });
  });

  test('references: what a rule starts, and ingest rules as starters of workflows and sequences', async () => {
    const fwd = await automation.references(db(), { email_ingest_rule_id: 15 });
    expect(fwd.map((r) => r.target_kind)).toEqual(['workflow', 'http', 'sequence_type', 'hook', 'internal_function', 'workflow', 'workflow']);
    expect(all(fwd)).not.toContain('SECRET-TOKEN');
    expect(fwd.find((r) => r.rule_action_id === 107).active).toBe(false);
    const wf = await automation.references(db(), { workflow_id: 24 });
    const starters = wf.filter((r) => /_ingest_rule$/.test(r.source));
    expect(starters).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'email_ingest_rule', email_ingest_rule_id: 15, active: true }),
      expect.objectContaining({ source: 'email_ingest_rule', email_ingest_rule_id: 15, active: false }),   // action 107
      expect.objectContaining({ source: 'phone_ingest_rule', phone_ingest_rule_id: 3, active: true }),    // "24" as a string
    ]));
    expect(starters).toHaveLength(3);
    const seq = await automation.references(db(), { sequence_template_id: 5 });
    expect(seq.filter((r) => r.source === 'email_ingest_rule')).toEqual([
      expect.objectContaining({ email_ingest_rule_id: 15, detail: expect.stringMatching(/by type "no_show"/) })]);
    const none = await automation.references(db(), { email_ingest_rule_id: 30 });
    expect(none).toEqual([expect.objectContaining({ source: 'none' })]);
  });

  test('preview: a stored rule against an execution — match, transform output, what each action WOULD do, redacted', async () => {
    const rows = await preview.previewRows(db(), { channel: 'email', rule_id: 15, execution_id: 28500 });
    expect(rows[0]).toMatchObject({ row: 'preview', email_ingest_rule_id: 15, email_ingest_execution_id: 28500, fidelity: 'full',
      matched: 1, transform_ok: 1, dry_run: 1, would_fire: expect.stringMatching(/^yes — 6 active action/) });
    expect(JSON.parse(rows[0].transform_output)).toEqual({ case_no: '26-40001', contact_id: 1309 });
    const would = (id) => rows.find((r) => r.row === 'would_fire_action' && r.rule_action_id === id).would;
    expect(would(101)).toMatch(/start workflow 24 "Court deadlines"/);
    expect(would(102)).toBe('send POST to host hooks.example.com [URL redacted] using Clio OAuth');
    expect(would(103)).toMatch(/enroll contact 1309 in the active template of type "no_show"/);
    expect(would(104)).toMatch(/INACTIVE — it would refuse/);
    expect(would(106)).toMatch(/be refused — workflow 25 "Retired flow" is inactive/);
    expect(would(107)).toMatch(/inactive and is never dispatched/);
    expect(JSON.parse(rows.find((r) => r.rule_action_id === 105).resolved_params))
      .toEqual({ case_no: '26-40001', all: { case_no: '26-40001', contact_id: 1309 }, fixed: 'lit' });
    const text = all(rows);
    expect(text).not.toContain('SECRET-TOKEN');
    expect(text).not.toContain(SECRET_HEADER);
  });

  test('preview semantics: throwing match, NULL conditions, failed transform, inactive rule, test replay', async () => {
    const thrown = (await preview.previewRows(db(), { channel: 'email', rule_id: 31, execution_id: 28500 }))[0];
    expect(thrown).toMatchObject({ matched: 0, transform_ok: null, would_fire: expect.stringMatching(/^no — the rule does not match/) });
    expect(thrown.match_note).toMatch(/code error: boom on Notice of Hearing/);
    const nul = (await preview.previewRows(db(), { channel: 'email', rule_id: 30, execution_id: 28500 }))[0];
    expect(nul).toMatchObject({ matched: 0 });
    expect(nul.match_note).toMatch(/NULL match_config on conditions mode — treating as non-match/);
    const bad = await preview.previewRows(db(), { channel: 'email', rule_id: 34, execution_id: 28500 });
    expect(bad[0]).toMatchObject({ matched: 1, transform_ok: 0, transform_error: expect.stringMatching(/must be an array/),
      would_fire: expect.stringMatching(/MATCHES but its transform fails, so no action fires/) });
    expect(bad).toHaveLength(1);                                        // no would_fire_action rows
    const off = await preview.previewRows(db(), { channel: 'email', rule_id: 33, execution_id: 28500 });
    expect(off[0]).toMatchObject({ rule_active: 0, matched: 1, note: expect.stringMatching(/INACTIVE: live ingest never evaluates it/) });
    expect(off.find((r) => r.rule_action_id === 130).would).toMatch(/has never been published/);
    const replay = await preview.previewRows(db(), { channel: 'email', rule_id: 15, execution_id: 28505 });
    expect(replay[0].is_test_replay).toBe(1);
    expect(replay.find((r) => r.rule_action_id === 101).would).toMatch(/"-test-" replay envelope skips workflow actions/);
    await expect(preview.previewRows(db(), { channel: 'email', rule_id: 15, execution_id: 28504 }))
      .rejects.toMatchObject({ status: 404, message: expect.stringMatching(/has no email_log row/) });
  });

  test('preview prepares the envelope as evaluateRules does (body = text||html); the native tester does not — pinned as found', async () => {
    const kind = (await preview.previewRows(db(), { channel: 'email', rule_id: 32, execution_id: 28500 }))[0];
    expect(kind.matched).toBe(1);                                       // production would match
    const native = await preview.testMatch(db(), 'email', { match_mode: 'conditions',
      match_config: { operator: 'and', conditions: [{ path: 'body', op: 'contains', value: 'hearing is set' }] }, exec_id: 28500 });
    expect(native.body.matched_count).toBe(0);                          // the native tester's divergence (ref/plans.md)
    // A reconstructed row keeps email_log.body, which IS that derivation.
    expect(preview.productionEnvelope('email', { body: 'b' }, { fidelity: 'reconstructed' })).toEqual({ body: 'b' });
    expect(preview.productionEnvelope('email', { text: 't', html: 'h' }, { fidelity: 'full' }).body).toBe('t');
    expect(preview.productionEnvelope('email', { body: 'given' }, { sample: true }).body).toBe('given');
    expect(preview.productionEnvelope('phone', { message: 'm' }, { fidelity: 'full' })).toEqual({ message: 'm' });
  });

  test('preview window + sample modes', async () => {
    const w = await preview.previewRows(db(), { channel: 'email', rule_id: 15, window: { limit: 10, since: '2026-10-26' } });
    // wide scope: duplicates (28501) and rows without email_log (28504) are out;
    // 28503 is before the firm-local day.
    expect(w[0]).toMatchObject({ row: 'preview_window', total: 3, matched_count: 3, window_total: 3, truncated: 0 });
    expect(w.slice(1).map((r) => r.email_ingest_execution_id)).toEqual([28500, 28502, 28505]);
    expect(w.slice(1).every((r) => r.row === 'preview_hit' && r.matched === 1)).toBe(true);
    const ph = await preview.previewRows(db(), { channel: 'phone', rule_id: 3, sample: { type: 'sms', from: '1', to: '2', message: 'hello' } });
    expect(ph[0]).toMatchObject({ matched: 1, fidelity: 'sample', transform_ok: 1 });
    expect(JSON.parse(ph[0].transform_output)).toEqual({ text: 'hello' });
    expect(ph.find((r) => r.row === 'would_fire_action').would).toMatch(/start workflow 24/);
    // Fail closed when the message source is lost.
    await expect(preview.previewRows(db(), { channel: 'email', rule_id: 15 })).rejects.toMatchObject({ status: 422 });
  });

  test('NOTHING is written: checksums identical after the full read + preview matrix on a pool that could write', async () => {
    // A full row snapshot, not CHECKSUM TABLE: the engine's CHECKSUM is not
    // stable across calls on a table with a VIRTUAL generated column + a
    // multi-valued index (both executions tables) — measured: two back-to-back
    // calls disagreed with nothing in between.
    const sums = async () => {
      const out = {};
      for (const t of CHECKSUM_TABLES) out[t] = JSON.stringify((await root.query(`SELECT * FROM \`${t}\` ORDER BY 1`))[0]);
      return out;
    };
    const [[meta0]] = await root.query('SELECT SUM(match_count) AS n, MAX(updated_at) AS u FROM email_ingest_rules');
    const before = await sums();
    statements.length = 0;
    const w = recorded(root);
    for (const id of [15, 24, 30, 31, 32, 33, 34]) {
      for (const exec of [28500, 28502, 28505]) await preview.previewRows(w, { channel: 'email', rule_id: id, execution_id: exec });
      await preview.previewRows(w, { channel: 'email', rule_id: id, window: { limit: 40 } });
      await preview.previewRows(w, { channel: 'email', rule_id: id, sample: { from: { email: 'a@uscourts.gov' }, subject: 'S 26-12345', text: 'hearing is set' } });
      await automation.definition(w, { email_ingest_rule_id: id });
      await automation.references(w, { email_ingest_rule_id: id });
    }
    await preview.previewRows(w, { channel: 'phone', rule_id: 3, execution_id: 12201 });
    await preview.testMatch(w, 'email', { match_mode: 'conditions', match_config: { operator: 'and', conditions: [] }, include_misses: true });
    await preview.testTransform(w, 'phone', { transform_mode: 'passthrough', exec_id: 12201 });
    for (const t of Object.keys(automation.INGEST_LIST_TYPES)) await automation.list(w, { type: t, limit: 50 });
    for (const id of [28500, 28501, 28502, 28503, 28504, 28505]) await automation.run(w, { email_ingest_execution_id: id });
    // Let any fire-and-forget write land before measuring.
    await new Promise((r) => setTimeout(r, 300));
    const after = await sums();
    for (const t of CHECKSUM_TABLES) expect({ t, same: after[t] === before[t] }).toEqual({ t, same: true });
    expect(before.email_ingest_rules.length).toBeGreaterThan(100);
    const [[meta1]] = await root.query('SELECT SUM(match_count) AS n, MAX(updated_at) AS u FROM email_ingest_rules');
    expect(meta1).toEqual(meta0);
    expect(statements.length).toBeGreaterThan(100);
    expect(statements.filter((s) => /^\s*(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|TRUNCATE)\b/i.test(s))).toEqual([]);
    expect(statements.filter((s) => /email_ingest_sources/i.test(s))).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  test('A20.2 trace: action writes do NOT move the parent rule\'s updated_at; a match-count bump DOES', async () => {
    const stamp = async () => (await q('SELECT updated_at FROM email_ingest_rules WHERE id = 24'))[0].updated_at.toISOString();
    await q("UPDATE email_ingest_rules SET updated_at = '2026-01-01 00:00:00' WHERE id = 24");
    const added = await ruleService.addAction(root, 24, { action_type: 'workflow', config: { workflow_id: 24 }, active: 0 });
    await ruleService.updateAction(root, added.id, { name: 'renamed', position: 9 });
    await ruleService.deleteAction(root, added.id);
    expect(await stamp()).toBe('2026-01-01T00:00:00.000Z');
    await ruleService._bumpMetrics(root, [24]);
    expect(await stamp()).not.toBe('2026-01-01T00:00:00.000Z');
    await q("UPDATE email_ingest_rules SET match_count = 0, last_matched_at = NULL, updated_at = '2026-01-01 00:00:00' WHERE id = 24");
  });
});
