// tests/caseyPipeline.mysql.test.js
//
/**
 * A9 on REAL MySQL: the services the Casey pipeline normalizer reads through
 * (caseService.getCase, pipelineService.getPipeline with requirements over the
 * real resolver, resolveMatterTemplate, pipelineAdminService.listStages /
 * listRequirements, triggerService.listActiveRulesForEvent) over rows mysql2
 * really returns, the one SQL of its own (the latest stage-log row's
 * template, the event's extra.from_template_id), and the native route
 * behaviour the cards rest on — routes/api.pipeline.js, real handlers, real
 * pool, under the production sql_mode.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a9_test npx jest tests/caseyPipeline.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyCaseContacts.mysql hygiene).
 *
 * WHAT IS LOCKED
 *   - THE ROUTE HAS NO REQUIREMENT GATE: POST /pipeline/advance passes over a
 *     required, unmet requirement and writes the log row — which is why the
 *     normalizer is the gate. The normalizer refuses that same move and names
 *     the requirement verbatim; an 'na' override satisfies it; an optional
 *     one is disclosed; the resolver's `required` arrives as the number 1/0.
 *   - A REPEAT IS A NOOP: the same advance twice writes ONE log row and emits
 *     case.stage_advanced ONCE (the route's own dedup under its per-case
 *     lock) — no stage-entry automation double-fires on a double click.
 *   - THE RETENTION CROSSING: an intake case whose subtype names the Chapter 7
 *     pipeline gets a crossing card onto its first stage; the route's advance
 *     BY KEY resolves to that pipeline (the intake template's own `retained`
 *     row is inactive) and writes pipeline_phase 'case' itself.
 *   - THE FOOTGUN THE REFUSAL AVOIDS: a blank subtype under an is_default
 *     chapter template is refused by the normalizer, while the route would
 *     have put that lead on the default chapter pipeline.
 *   - The dry run reads the real active rules (an inactive one, and one on
 *     another event, are not listed) and the real latest log row's template.
 *   - The browser's click-time recompute (casePipelinePassed, extracted from
 *     public/assistant.html) over the REAL GET ?requirements=1 payload gives
 *     the card's own expected signature.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The route's dependencies that are NOT under test: the auth gate (pinned in
// tests/caseyActionPermissions.test.js) and the fire-and-forget event queue,
// observed instead of run. buildEnvelope stays REAL — the normalizer dry-runs
// the envelope it builds (jest.requireActual, never a partial factory).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'pipeline_templates', 'pipeline_stages', 'pipeline_stage_requirements',
  'case_stage_log', 'case_requirement_overrides', 'trigger_rules', 'trigger_rule_actions'];

function schemaFor(tables) {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'ref', 'database.sql'), 'utf8').split('\n');
  const creates = []; const alters = [];
  for (let i = 0; i < lines.length; i++) {
    for (const t of tables) {
      if (lines[i].startsWith(`CREATE TABLE \`${t}\` (`)) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/^\) ENGINE=.*;$/.test(lines[i])) break; }
        creates.push(buf.join('\n'));
      } else if (lines[i] === `ALTER TABLE \`${t}\``) {
        const buf = [];
        for (; i < lines.length; i++) { buf.push(lines[i]); if (/;\s*$/.test(lines[i])) break; }
        const head = buf[0];
        const clauses = buf.slice(1).map((l) => l.replace(/[,;]\s*$/, ''))
          .filter((l) => { const m = /REFERENCES `([a-z_]+)`/.exec(l); return !m || tables.includes(m[1]); });
        if (clauses.length) alters.push(`${head}\n${clauses.join(',\n')};`);
      }
    }
  }
  if (creates.length !== tables.length) throw new Error(`schema extraction found ${creates.length} CREATE blocks`);
  alters.sort((a, b) => /FOREIGN KEY/.test(a) - /FOREIGN KEY/.test(b));
  return { creates, alters };
}

function call(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({ port: srv.address().port, path: urlPath, method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.end(payload);
    });
  });
}

// The browser's recompute, extracted verbatim from the page (the assistantUi
// fnSrc idiom, inlined).
function browserPassed() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  const m = /function\s+casePipelinePassed\s*\(/.exec(html);
  if (!m) throw new Error('casePipelinePassed not found');
  let depth = 0;
  for (let i = html.indexOf('{', m.index + m[0].length); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) {
      return new Function(`${html.slice(m.index, i + 1)}; return casePipelinePassed;`)(); // eslint-disable-line no-new-func
    }
  }
  throw new Error('casePipelinePassed unbalanced');
}

d('the Casey pipeline cards on real MySQL (A9)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A9CASE01'; const C2 = 'A9CASE02'; const C3 = 'A9CASE03';

  async function dropAll(conn) {
    const [children] = await conn.query(
      `SELECT DISTINCT TABLE_NAME AS t FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (?) AND TABLE_NAME NOT IN (?)`, [TABLES, TABLES]);
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...new Set(children.map((r) => r.t)), ...[...TABLES].reverse()]) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  async function seed() {
    for (const t of [...TABLES].reverse()) await q(`DELETE FROM \`${t}\``);
    // Chapter 7 is_default=1 on purpose: the type-default path the crossing refuses.
    await q(`INSERT INTO pipeline_templates (id, name, case_type, case_subtype, role, is_default, active) VALUES
      (1, 'Intake', '', '', 'intake', 0, 1), (2, 'Chapter 7', 'Bankruptcy', 'Chapter 7', 'case', 1, 1)`);
    // Intake's own `retained` row is INACTIVE, as live (pipelineService PROJECTION_GENERIC_STAGE_KEY).
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_key, stage_number, internal_label, client_label, case_stage, lane, default_rec, client_visible, active) VALUES
      (11, 1, 'consult_booked', 1, 'Consult booked', 'Consult', 'Open', 'main', 'Hold the consult', 1, 1),
      (12, 1, 'consult_done', 2, 'Consult done', 'Consult done', 'Open', 'main', 'Send the contract', 1, 1),
      (13, 1, 'contract_sent', 3, 'Contract sent', 'Contract sent', 'Open', 'main', '', 1, 1),
      (14, 1, 'retained', 4, 'Retained', 'Retained', 'Open', 'main', '', 1, 0),
      (19, 1, 'dead_lead', 91, 'Dead lead', NULL, 'Closed', 'offramp', '', 0, 1),
      (21, 2, 'retained', 1, 'Retained', 'Retained', 'Open', 'main', 'Request documents', 1, 1),
      (22, 2, 'docs', 2, 'Docs requested', 'Documents', 'Open', 'main', '', 1, 1),
      (23, 2, 'filed', 3, 'Filed', 'Filed', 'Filed', 'main', '', 1, 1),
      (29, 2, 'dismissed', 90, 'Dismissed', 'Dismissed', 'Closed', 'offramp', '', 1, 1)`);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, required, owner, detector, detector_config, sort_order, active) VALUES
      (301, 11, 'questionnaire', 'Intake questionnaire submitted', 1, 'client', 'manual', NULL, 1, 1),
      (302, 11, 'courtesy', 'Courtesy call', 0, 'staff', 'manual', NULL, 2, 1),
      (303, 13, 'contract_signed', 'Retainer contract signed', 1, 'client', 'manual', NULL, 1, 1),
      (304, 21, 'fee', 'Retainer fee paid', 1, 'client', 'manual', NULL, 1, 1),
      (305, 21, 'retired', 'Retired step', 1, 'client', 'manual', NULL, 2, 0)`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, pipeline_phase, case_stage, case_status, case_rec) VALUES
      (?, '25-50001', 'Bankruptcy', 'Chapter 7', 'intake', 'Open', 'Consult booked', 'Call back Tuesday'),
      (?, '25-50002', 'Bankruptcy', 'Chapter 7', 'intake', 'Open', 'Contract sent', ''),
      (?, '25-50003', 'Bankruptcy', '', 'intake', 'Open', 'Contract sent', '')`, [C1, C2, C3]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES (5001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (801, ?, 5001, 'Primary')`, [C1]);
    await q(`INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source) VALUES
      (?, 1, 11, 'consult_booked', 'Open', 'Consult booked', '2026-10-01 10:00:00', 6, 'manual'),
      (?, 1, 11, 'consult_booked', 'Open', 'Consult booked', '2026-10-01 10:00:00', 6, 'manual'),
      (?, 1, 12, 'consult_done', 'Open', 'Consult done', '2026-10-02 10:00:00', 6, 'manual'),
      (?, 1, 13, 'contract_sent', 'Open', 'Contract sent', '2026-10-03 10:00:00', 6, 'manual'),
      (?, 1, 13, 'contract_sent', 'Open', 'Contract sent', '2026-10-03 10:00:00', 6, 'manual')`, [C1, C2, C2, C2, C3]);
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, set_by) VALUES
      (?, 'questionnaire', 'na', 6), (?, 'contract_signed', 'done', 6), (?, 'questionnaire', 'na', 6), (?, 'contract_signed', 'done', 6)`, [C2, C2, C3, C3]);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'case.stage_advanced', 'Stage change → case log', 1, 1, 'conditions', '{"operator":"and","conditions":[]}'),
      (2, 'case.stage_advanced', 'Retained from intake → onboarding', 1, 2, 'conditions',
        '{"operator":"and","conditions":[{"path":"data.stage_key","op":"equals","value":"retained"},{"path":"extra.from_template_id","op":"equals","value":"1"},{"path":"extra.from_stage","op":"equals","value":"contract_sent"}]}'),
      (3, 'case.stage_advanced', 'Switched off', 0, 3, 'conditions', '{"operator":"and","conditions":[]}'),
      (4, 'case.updated', 'Other event', 1, 1, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, 'Log it', 1, 1, 'internal_function', '{"function_name":"create_log"}'),
      (2, NULL, 1, 1, 'workflow', '{"workflow_id":42}'), (2, 'Off', 2, 0, 'workflow', '{"workflow_id":43}'),
      (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}'), (4, NULL, 1, 1, 'workflow', '{"workflow_id":8}')`);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }, { case_id: C2 }, { case_id: C3 }] }];
  const cite = (n) => [{ query_id: 'q1', row_number: n }];
  const card = (value) => normalizeActionDraft(pool, value, ev, { currentUserId: 6 });
  const logRows = (id) => q('SELECT template_id, stage_id, stage_key, note FROM case_stage_log WHERE case_id = ? ORDER BY entered_at, id', [id]);

  beforeAll(async () => {
    const dbName = new URL(URL_).pathname.slice(1);
    if (!/_test$/.test(dbName)) throw new Error(`refusing to run against "${dbName}"`);
    if (new URL(URL_).port === '3306') throw new Error('refusing to run against the production proxy port');
    pool = mysql.createPool({ uri: URL_, connectionLimit: 10, timezone: 'Z' });
    pool.on('connection', (conn) => conn.query(`SET SESSION sql_mode = '${PROD_SQL_MODE}'`));
    const conn = await pool.getConnection();
    try {
      await dropAll(conn);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      const { creates, alters } = schemaFor(TABLES);
      for (const sql of creates) await conn.query(sql);
      for (const sql of alters) await conn.query(sql);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    } finally { conn.release(); }
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.pipeline'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('THE ROUTE HAS NO REQUIREMENT GATE — the normalizer refuses the move the route would make, naming the step', async () => {
    await expect(card({ kind: 'case.pipeline.advance.v1', case_id: C1, evidence: cite(1) })).rejects.toThrow(
      'UNMET REQUIREMENTS: moving case 25-50001 from Consult booked (consult_booked) to Consult done (consult_done) would pass over 1 required step that is not done: "Intake questionnaire submitted" (stage Consult booked, active, client). Casey never moves a case past an unmet requirement and cannot override one.');
    const res = await call(app, 'POST', `/api/cases/${C1}/pipeline/advance`, { stage: 'consult_done' });
    expect([res.status, res.body.noop, res.body.current.stage_key]).toEqual([200, false, 'consult_done']);
    expect((await logRows(C1)).map((r) => r.stage_key)).toEqual(['consult_booked', 'consult_done']);
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  });

  test('an N/A override satisfies the step; the optional one is disclosed; the card reads the real row types', async () => {
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, set_by) VALUES (?, 'questionnaire', 'na', 6)`, [C1]);
    const c = await card({ kind: 'case.pipeline.advance.v1', case_id: C1, note: 'consult held', evidence: cite(1) });
    expect(c).toMatchObject({
      case: { case_id: C1, case_number: '25-50001', clients: ['Dana Debtor'] },
      from: { stage_key: 'consult_booked', stage_id: 11, on_pipeline: true },
      to: { template_id: 1, stage_id: 12, stage_key: 'consult_done', stage_number: 2, lane: 'main', client_visible: 1 },
      crossing: false,
      writes: { case_status: { from: 'Consult booked', to: 'Consult done' }, case_rec: { from: 'Call back Tuesday', to: 'Send the contract' }, pipeline_phase: { from: 'intake', to: 'intake' } },
      requirements: { satisfied: [{ internal_label: 'Intake questionnaire submitted', stage_label: 'Consult booked', status: 'na' }],
        optional_skipped: [{ internal_label: 'Courtesy call', stage_label: 'Consult booked', status: 'active' }], destination: [] },
      expected: { template_id: 1, stage_key: 'consult_booked', history_count: 1, pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
        requirements: ['courtesy@11:active:0', 'questionnaire@11:na:1'] },
    });
    // The dry run read the real active rules: the always-match rule fires, the
    // retained-only rule and the inactive / other-event rules are not listed.
    expect(c.automation).toEqual({ rules_checked: 2, quiet: 1, lines: ['Trigger rule #1 "Stage change → case log" runs: calls create_log ("Log it")'] });
    // A same-template move to the off-ramp passes the same steps (and contract_sent's, still open → refused).
    await expect(card({ kind: 'case.pipeline.move.v1', case_id: C1, stage: 'Dead lead', evidence: cite(1) })).rejects.toThrow(
      /would pass over 1 required step that is not done: "Retainer contract signed" \(stage Contract sent, upcoming, client\)/);
  });

  test('A REPEAT IS A NOOP: the same advance twice writes one row and emits once (no double-fired automation)', async () => {
    const first = await call(app, 'POST', `/api/cases/${C1}/pipeline/advance`, { stage: 'consult_done', note: 'once' });
    const again = await call(app, 'POST', `/api/cases/${C1}/pipeline/advance`, { stage: 'consult_done', note: 'twice' });
    expect([first.status, first.body.noop, 'changes' in first.body]).toEqual([200, false, true]);
    expect([again.status, again.body.noop, 'changes' in again.body]).toEqual([200, true, false]);
    expect((await logRows(C1)).map((r) => [r.stage_key, r.note])).toEqual([['consult_booked', null], ['consult_done', 'once']]);
    expect(domainEvents.emit).toHaveBeenCalledTimes(1);
  });

  test('THE RETENTION CROSSING: a crossing card onto Chapter 7\'s first stage; the route by key lands there and writes the phase', async () => {
    const c = await card({ kind: 'case.pipeline.advance.v1', case_id: C2, evidence: cite(2) });
    expect(c).toMatchObject({
      crossing: true,
      to: { template_id: 2, template_name: 'Chapter 7', template_role: 'case', stage_id: 21, stage_key: 'retained', stage_number: 1 },
      writes: { pipeline_phase: { from: 'intake', to: 'case' }, case_rec: { from: '', to: 'Request documents' } },
      // Definitions only (status decided once entered); the inactive step is not listed.
      requirements: { destination: [{ internal_label: 'Retainer fee paid', required: 1, status: null }],
        satisfied: [{ internal_label: 'Intake questionnaire submitted', stage_label: 'Consult booked', status: 'na' },
          { internal_label: 'Retainer contract signed', stage_label: 'Contract sent', status: 'done' }] },
      expected: { template_id: 1, stage_key: 'contract_sent', history_count: 3,
        requirements: ['contract_signed@13:done:1', 'courtesy@11:skipped:0', 'questionnaire@11:na:1'] },
    });
    expect(c.warnings[0]).toMatch(/^LIFECYCLE — THIS RETAINS THE CASE/);
    // extra.from_template_id / from_stage came from the REAL latest log row
    // (template 1, contract_sent — not the first row): the rule matches.
    expect(c.automation.lines).toEqual([
      'Trigger rule #1 "Stage change → case log" runs: calls create_log ("Log it")',
      'Trigger rule #2 "Retained from intake → onboarding" runs: starts workflow #42',
    ]);
    const res = await call(app, 'POST', `/api/cases/${C2}/pipeline/advance`, { stage: c.to.stage_key });
    expect([res.status, res.body.template.id, res.body.current.stage_id]).toEqual([200, 2, 21]);
    expect(res.body.changes).toEqual({ case_stage: 'Open', case_status: 'Retained', case_rec: 'Request documents', pipeline_phase: 'case' });
    expect((await q('SELECT pipeline_phase FROM cases WHERE case_id = ?', [C2]))[0].pipeline_phase).toBe('case');
    expect((await logRows(C2)).pop()).toMatchObject({ template_id: 2, stage_id: 21, stage_key: 'retained' });
  });

  test('THE FOOTGUN: a blank subtype under an is_default chapter pipeline is refused, while the route would file it there', async () => {
    await expect(card({ kind: 'case.pipeline.advance.v1', case_id: C3, evidence: cite(3) })).rejects.toThrow(
      /its next step is its chapter pipeline, but its subtype \(blank\) does not name the Chapter 7 pipeline exactly — entering it would rest on the case type's default pipeline/);
    const res = await call(app, 'POST', `/api/cases/${C3}/pipeline/advance`, { stage: 'retained' });
    expect([res.status, res.body.template.id]).toEqual([200, 2]);
  });

  test('the browser\'s click-time recompute over the REAL GET ?requirements=1 equals the card\'s expected signature', async () => {
    const passed = browserPassed();
    const sig = (rows) => rows.map((r) => `${r.requirement_key}@${r.stage_id}:${r.status}:${r.required}`).sort();
    const crossing = await card({ kind: 'case.pipeline.advance.v1', case_id: C2, evidence: cite(2) });
    const g2 = await call(app, 'GET', `/api/cases/${C2}/pipeline?requirements=1`);
    expect(g2.status).toBe(200);
    expect(sig(passed(crossing, g2.body))).toEqual(crossing.expected.requirements);
    // The crossing's click check reads the projection of the same payload.
    expect([g2.body.projected.source, g2.body.projected.template.id, g2.body.projected.stages[0].stage_key]).toEqual(['subtype', 2, 'retained']);
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, set_by) VALUES (?, 'questionnaire', 'done', 6), (?, 'contract_signed', 'na', 6)`, [C1, C1]);
    const off = await card({ kind: 'case.pipeline.move.v1', case_id: C1, stage: 'dead_lead', evidence: cite(1) });
    const g1 = await call(app, 'GET', `/api/cases/${C1}/pipeline?requirements=1`);
    expect(off.expected.requirements).toEqual(['contract_signed@13:na:1', 'courtesy@11:active:0', 'questionnaire@11:done:1']);
    expect(sig(passed(off, g1.body))).toEqual(off.expected.requirements);
    // And the resolver's `required` / `stage_id` arrive as numbers.
    const r = g1.body.stages.find((s) => s.stage_key === 'consult_booked').requirements[0];
    expect([typeof r.required, typeof r.stage_id]).toEqual(['number', 'number']);
  });
});
