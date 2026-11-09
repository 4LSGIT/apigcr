// tests/caseyPipelineTransfer.mysql.test.js
//
/**
 * A9.3 on REAL MySQL: the Casey cross-pipeline transfer card
 * (case.pipeline.transfer.v1) over rows mysql2 really returns, beside the
 * REAL route it sends — routes/api.pipeline.js POST /pipeline/move →
 * pipelineService.movePipeline (caseService.updateCase, then advanceStage) —
 * real handlers, real pool, under the production sql_mode.
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a93_test npx jest tests/caseyPipelineTransfer.mysql.test.js --runInBand
 * The database name must end in _test (port 3306 is refused — on a dev
 * machine that is production); this suite DROPS and recreates its tables in
 * it, cloned from ref/database.sql (live types and keys; a clause referencing
 * a table outside the list is dropped). Drops run with FOREIGN_KEY_CHECKS off
 * in the before-hook AND the after-hook and take any sibling-built child of
 * ours with them. Give it its own *_test DB (it rebuilds tables the A9 twin
 * builds too).
 *
 * WHAT IS LOCKED
 *   - THE CARD'S PROJECTION IS THE RESOLVER'S READ: the passed-over steps the
 *     card discloses on the destination (override 'na', a REAL case_field
 *     detector satisfied, plain manual steps, an inactive step absent) equal,
 *     status for status, what the real resolver reads once the real route has
 *     moved the case; the route passes over the unmet required steps (no gate)
 *     — which is why the card discloses them.
 *   - THE MEMBERSHIP WRITE: only the column that differs is written; the real
 *     route emits case.updated (source pipeline_move) and case.stage_advanced
 *     with the post-membership subtype and the default note — the envelopes
 *     the card dry-ran; an intake destination writes NO type / subtype, keeps
 *     the subtype and emits no case.updated.
 *   - THE RESOLVER DRY-RUN: a destination the post-state resolves to is a card;
 *     a duplicate that loses to a lower id, and a matter template with no case
 *     type, are refused — and the real route, given the duplicate, really files
 *     the case on a phantom position (the fresh pipeline resolves elsewhere),
 *     which the browser's result check reads as a known FAILURE.
 *   - THE TORN STATE: with the case's pipeline lock held elsewhere, the real
 *     route writes the type / subtype, then the advance 409s; its message is
 *     the torn one, the browser reads it as "Failed — partly written" (never
 *     applied, never "nothing written"), the case resolves to the destination
 *     with its old stage off that pipeline — and a new transfer card for it is
 *     refused toward the move card, as the card's recovery line says.
 *   - THE CLICK PRECHECK over the REAL GETs (the case, its pipeline, the two
 *     pipeline-admin reads) passes a fresh card — every signature computed
 *     from real row types — and refuses one whose destination stage changed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The routes' dependencies NOT under test: the auth gates (pinned in
// tests/caseyActionPermissions.test.js) and the fire-and-forget event queue,
// observed instead of run. buildEnvelope / buildChanges stay REAL.
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
jest.mock('../lib/domainEvents', () => ({ ...jest.requireActual('../lib/domainEvents'), emit: jest.fn() }));
const domainEvents = require('../lib/domainEvents');
const { normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const TABLES = ['cases', 'contacts', 'case_relate', 'pipeline_templates', 'pipeline_stages', 'pipeline_stage_requirements',
  'case_stage_log', 'case_requirement_overrides', 'trigger_rules', 'trigger_rule_actions', 'field_defs'];

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

// The browser half, extracted verbatim from the page (the assistantUi fnSrc idiom).
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
function fnSrc(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  if (!m) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = html.indexOf('{', html.indexOf(')', m.index)); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(m.index, i + 1);
  }
  throw new Error(`function ${name} unbalanced`);
}
function browser(api) {
  const torn = /const\s+CASE_TRANSFER_TORN\s*=[^\n]*\n/.exec(html);
  if (!torn) throw new Error('CASE_TRANSFER_TORN not found');
  const fns = ['actionStringReceipt', 'casePipelineCaseLabel', 'casePipelineStageName', 'caseTransferRequest', 'caseTransferPrecheck', 'caseTransferResult', 'caseTransferKnownOutcome'];
  return new Function('api', `${torn[0]}\n${fns.map(fnSrc).join('\n')}\nreturn { ${fns.join(', ')} };`)(api); // eslint-disable-line no-new-func
}

d('the Casey pipeline transfer card on real MySQL (A9.3)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const C1 = 'A93CASE1'; const C2 = 'A93CASE2'; const C3 = 'A93CASE3';

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
    // #4 duplicates #3's (type, subtype) and loses to it on id; #5 has no case type.
    await q(`INSERT INTO pipeline_templates (id, name, case_type, case_subtype, role, is_default, active) VALUES
      (1, 'Intake', '', '', 'intake', 0, 1), (2, 'Chapter 7', 'Bankruptcy', 'Chapter 7', 'case', 1, 1),
      (3, 'Chapter 13', 'Bankruptcy', 'Chapter 13', 'case', 0, 1), (4, 'Chapter 13 (dup)', 'Bankruptcy', 'Chapter 13', 'case', 0, 1),
      (5, 'Misc', '', '', 'case', 0, 1)`);
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_key, stage_number, internal_label, client_label, case_stage, lane, default_rec, client_visible, active) VALUES
      (11, 1, 'consult_booked', 1, 'Consult booked', 'Consult', 'Open', 'main', '', 1, 1),
      (13, 1, 'contract_sent', 3, 'Contract sent', 'Contract sent', 'Open', 'main', '', 1, 1),
      (21, 2, 'retained', 1, 'Retained', 'Retained', 'Open', 'main', '', 1, 1),
      (23, 2, 'filed', 3, 'Filed', 'Filed', 'Filed', 'main', 'Wait for the 341', 1, 1),
      (24, 2, 'discharged', 4, 'Discharged', 'Discharged', 'Concluded', 'main', '', 1, 1),
      (31, 3, 'retained', 1, 'Retained', 'Retained', 'Open', 'main', '', 1, 1),
      (32, 3, 'docs', 2, 'Docs requested', 'Documents', 'Open', 'main', '', 1, 1),
      (33, 3, 'filed', 3, 'Filed', 'Filed', 'Filed', 'main', 'Await the plan hearing', 1, 1),
      (34, 3, 'confirmed', 4, 'Plan confirmed', 'Plan confirmed', 'Filed', 'main', 'Watch plan payments', 1, 1),
      (36, 3, 'hearing', 5, 'Old hearing', NULL, 'Filed', 'main', '', 0, 0),
      (41, 4, 'filed', 1, 'Filed', 'Filed', 'Filed', 'main', '', 1, 1),
      (51, 5, 'start', 1, 'Start', NULL, 'Open', 'main', '', 0, 1)`);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, required, owner, detector, detector_config, sort_order, active) VALUES
      (301, 31, 'fee', 'Retainer fee paid', 1, 'client', 'manual', NULL, 1, 1),
      (302, 31, 'courtesy', 'Courtesy call', 0, 'staff', 'manual', NULL, 2, 1),
      (303, 32, 'w2', 'W-2s received', 1, 'client', 'manual', NULL, 1, 1),
      (304, 32, 'retired', 'Retired step', 1, 'client', 'manual', NULL, 2, 0),
      (305, 32, 'file_date', 'File date recorded', 1, 'staff', 'case_field', '{"field":"case_file_date"}', 3, 1),
      (306, 33, 'plan_filed', 'Plan filed', 1, 'staff', 'manual', NULL, 1, 1),
      (307, 23, 'cc_cert', 'Credit counseling certificate', 1, 'client', 'manual', NULL, 1, 1)`);
    await q(`INSERT INTO cases (case_id, case_number, case_type, case_subtype, pipeline_phase, case_stage, case_status, case_rec, case_file_date) VALUES
      (?, '25-60001', 'Bankruptcy', 'Chapter 7', 'case', 'Filed', 'Filed', 'Wait for the 341', '2026-09-01'),
      (?, '25-60002', 'Bankruptcy', 'Chapter 7', 'case', 'Concluded', 'Discharged', '', NULL),
      (?, '25-60003', 'Bankruptcy', 'Chapter 7', 'case', 'Filed', 'Filed', '', NULL)`, [C1, C2, C3]);
    await q(`INSERT INTO contacts (contact_id, contact_kind, contact_name, contact_fname, contact_lname) VALUES (6001, 'person', 'Dana Debtor', 'Dana', 'Debtor')`);
    await q(`INSERT INTO case_relate (case_relate_id, case_relate_case_id, case_relate_client_id, case_relate_type) VALUES (901, ?, 6001, 'Primary')`, [C1]);
    await q(`INSERT INTO case_stage_log (case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source) VALUES
      (?, 2, 21, 'retained', 'Open', 'Retained', '2026-09-01 10:00:00', 6, 'manual'),
      (?, 2, 23, 'filed', 'Filed', 'Filed', '2026-09-02 10:00:00', 6, 'manual'),
      (?, 2, 24, 'discharged', 'Concluded', 'Discharged', '2026-09-03 10:00:00', 6, 'manual'),
      (?, 2, 23, 'filed', 'Filed', 'Filed', '2026-09-04 10:00:00', 6, 'manual')`, [C1, C1, C2, C3]);
    await q(`INSERT INTO case_requirement_overrides (case_id, requirement_key, status, set_by) VALUES (?, 'w2', 'na', 6)`, [C1]);
    await q(`INSERT INTO trigger_rules (id, event_type, name, active, position, match_mode, match_config) VALUES
      (1, 'case.updated', 'Subtype now Chapter 13', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"changes.case_subtype.to","op":"equals","value":"Chapter 13"}]}'),
      (2, 'case.stage_advanced', 'Moved by the default note', 1, 1, 'conditions', '{"operator":"and","conditions":[{"path":"extra.note","op":"equals","value":"Moved to \\\\"Chapter 13\\\\""}]}'),
      (3, 'case.stage_advanced', 'Switched off', 0, 2, 'conditions', '{"operator":"and","conditions":[]}')`);
    await q(`INSERT INTO trigger_rule_actions (rule_id, name, position, active, action_type, config) VALUES
      (1, NULL, 1, 1, 'workflow', '{"workflow_id":77}'), (2, 'Log it', 1, 1, 'internal_function', '{"function_name":"create_log"}'),
      (3, NULL, 1, 1, 'workflow', '{"workflow_id":9}')`);
  }
  const ev = [{ id: 'q1', rows: [{ case_id: C1 }, { case_id: C2 }, { case_id: C3 }] }];
  const cite = (n) => [{ query_id: 'q1', row_number: n }];
  const card = (value) => normalizeActionDraft(pool, value, ev, { currentUserId: 6 });
  const logRows = (id) => q('SELECT template_id, stage_id, stage_key, note FROM case_stage_log WHERE case_id = ? ORDER BY entered_at, id', [id]);
  const caseRow = async (id) => (await q('SELECT case_type, case_subtype, pipeline_phase, case_stage, case_status, case_rec FROM cases WHERE case_id = ?', [id]))[0];
  // The browser's api(): GETs through the real routes, a non-2xx as the shell's apiSend throws it.
  const realApi = async (p, body, method) => {
    if (method !== 'GET') throw new Error(`unexpected ${method} ${p}`);
    const res = await call(app, 'GET', p);
    if (res.status >= 400) throw Object.assign(new Error(res.body.message || `HTTP ${res.status}`), { status: res.status, body: res.body });
    return res.body;
  };

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
    app.use(require('../routes/api.pipelineAdmin'));
    app.use(require('../routes/api.cases'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); domainEvents.emit.mockClear(); });

  test('THE CARD\'S PROJECTION IS THE RESOLVER\'S READ: the steps it discloses on Chapter 13 are exactly what the real resolver reads after the real route moved the case', async () => {
    const c = await card({ kind: 'case.pipeline.transfer.v1', case_id: C1, pipeline: 'Chapter 13', stage: 'confirmed', evidence: cite(1) });
    expect(c).toMatchObject({
      to: { template_id: 3, stage_id: 34, stage_key: 'confirmed', stage_number: 4 },
      membership: { case_subtype: { from: 'Chapter 7', to: 'Chapter 13' } },
      requirements: {
        passed_required: [{ internal_label: 'Retainer fee paid', stage_label: 'Retained', status: 'skipped', owner: 'client' },
          { internal_label: 'Plan filed', stage_label: 'Filed', status: 'skipped', owner: 'staff' }],
        optional_skipped: [{ internal_label: 'Courtesy call', stage_label: 'Retained', status: 'skipped' }],
        // The N/A override, and the REAL case_field detector (case_file_date is set); the inactive step is absent.
        satisfied: [{ internal_label: 'W-2s received', status: 'na' }, { internal_label: 'File date recorded', status: 'done' }],
        leaving_open: [{ internal_label: 'Credit counseling certificate', stage_label: 'Filed', status: 'active' }],
      },
      expected: { template_id: 2, stage_key: 'filed', history_count: 2, dest_stages: ['31:retained:1:main:2', '32:docs:2:main:3', '33:filed:3:main:1', '34:confirmed:4:main:0'] },
    });
    expect(c.warnings.find((w) => /^PASSED-OVER/.test(w))).toBe('PASSED-OVER REQUIRED STEPS: landing at Plan confirmed (confirmed) on Chapter 13 passes over 2 required steps that are not done or N/A: "Retainer fee paid" (stage Retained, skipped, client); "Plan filed" (stage Filed, skipped, staff) — they will read skipped once the case is there (the case page\'s move allows it; Casey cannot mark a step done or N/A — the user can, on the case\'s Steps panel).');
    // Both events dry-run on the real active rules (the inactive one is not checked).
    expect(c.automation).toEqual({
      case_updated: { rules_checked: 1, quiet: 0, lines: ['Trigger rule #1 "Subtype now Chapter 13" runs: starts workflow #77'] },
      stage_advanced: { rules_checked: 1, quiet: 0, lines: ['Trigger rule #2 "Moved by the default note" runs: calls create_log ("Log it")'] },
    });
    // The real route: no requirement gate — it moves the case over the two unmet steps.
    const res = await call(app, 'POST', `/api/cases/${C1}/pipeline/move`, { template_id: 3, stage_id: 34 });
    expect([res.status, res.body.noop, res.body.moved, res.body.template.id, res.body.current.stage_key])
      .toEqual([200, false, { template_id: 3, template_name: 'Chapter 13', fields_updated: true }, 3, 'confirmed']);
    // The browser's result check accepts the real payload.
    expect(browser(realApi).caseTransferResult(c, { status: 'success', ...res.body })).toEqual({ case_id: C1 });
    expect(await caseRow(C1)).toMatchObject({ case_type: 'Bankruptcy', case_subtype: 'Chapter 13', pipeline_phase: 'case', case_status: 'Plan confirmed', case_rec: 'Watch plan payments' });
    expect((await logRows(C1)).pop()).toEqual({ template_id: 3, stage_id: 34, stage_key: 'confirmed', note: 'Moved to "Chapter 13"' });
    // The real resolver now: every step below the destination, status for status, as the card projected.
    const after = await call(app, 'GET', `/api/cases/${C1}/pipeline?requirements=1`);
    const below = after.body.stages.filter((s) => s.stage_number < 4)
      .flatMap((s) => s.requirements.map((r) => `${r.internal_label}@${s.internal_label}:${r.status}:${r.required}`)).sort();
    const projected = [...c.requirements.passed_required.map((r) => ({ ...r, required: 1 })), ...c.requirements.optional_skipped.map((r) => ({ ...r, required: 0 })),
      ...c.requirements.satisfied.map((r) => ({ ...r, required: 1 }))].map((r) => `${r.internal_label}@${r.stage_label}:${r.status}:${r.required}`).sort();
    expect(below).toEqual(projected);
    // The events the route emitted are the ones the card dry-ran.
    const emitted = domainEvents.emit.mock.calls.map(([, type, payload]) => [type, payload]);
    expect(emitted.map(([t]) => t)).toEqual(['case.updated', 'case.stage_advanced']);
    expect(emitted[0][1]).toMatchObject({ case_id: C1, source: 'pipeline_move', changes: { case_subtype: { from: 'Chapter 7', to: 'Chapter 13' } }, extra: { updated_fields: ['case_subtype'] } });
    expect(emitted[1][1]).toMatchObject({ source: 'manual', data: { stage_key: 'confirmed', template_id: 3, case_subtype: 'Chapter 13' }, extra: { from_stage: 'filed', from_template_id: 2, note: c.log_note } });
  });

  test('AN INTAKE DESTINATION writes no type / subtype, keeps the subtype and emits no case.updated — on the card and on the real route', async () => {
    const c = await card({ kind: 'case.pipeline.transfer.v1', case_id: C3, pipeline: 'Intake', stage: 'contract_sent', evidence: cite(3) });
    expect([c.membership, c.automation.case_updated, c.writes.pipeline_phase]).toEqual([{}, null, { from: 'case', to: 'intake' }]);
    const res = await call(app, 'POST', `/api/cases/${C3}/pipeline/move`, { template_id: 1, stage_id: 13 });
    expect([res.status, res.body.moved.fields_updated, res.body.template.id]).toEqual([200, false, 1]);
    expect(await caseRow(C3)).toMatchObject({ case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'intake' });
    expect(domainEvents.emit.mock.calls.map(([, type]) => type)).toEqual(['case.stage_advanced']);
  });

  test('THE RESOLVER DRY-RUN: a duplicate that loses on id and a pipeline with no case type are refused — and the real route really leaves a phantom, which the result check reads as a failure', async () => {
    await expect(card({ kind: 'case.pipeline.transfer.v1', case_id: C3, pipeline: 4, evidence: cite(3) })).rejects.toThrow(
      /^PIPELINE DOES NOT RESOLVE: after this move case 25-60003 would resolve to the Chapter 13 pipeline, not Chapter 13 \(dup\) — with type \/ subtype Bankruptcy \/ Chapter 13 the resolver picks Chapter 13 \(#3\) first\./);
    await expect(card({ kind: 'case.pipeline.transfer.v1', case_id: C3, pipeline: 'Misc', evidence: cite(3) })).rejects.toThrow(
      /^PIPELINE DOES NOT RESOLVE: after this move case 25-60003 would resolve to the Chapter 7 pipeline, not Misc — Misc has no case type/);
    // The positive twin of the same case: Chapter 13 resolves.
    await expect(card({ kind: 'case.pipeline.transfer.v1', case_id: C3, pipeline: 'Chapter 13', evidence: cite(3) })).resolves.toMatchObject({ to: { template_id: 3, stage_key: 'filed' } });
    // What the refusal prevents: the route answers 200, the log row is on #4, the case resolves to #3.
    const res = await call(app, 'POST', `/api/cases/${C3}/pipeline/move`, { template_id: 4, stage_id: 41 });
    expect([res.status, res.body.moved.template_id, res.body.template.id]).toEqual([200, 4, 3]);
    expect((await logRows(C3)).pop()).toMatchObject({ template_id: 4, stage_id: 41 });
    const phantomCard = { case: { case_id: C3, case_number: '25-60003' }, to: { template_id: 4, template_name: 'Chapter 13 (dup)', stage_id: 41, stage_key: 'filed' } };
    let err = null;
    try { browser(realApi).caseTransferResult(phantomCard, { status: 'success', ...res.body }); } catch (e) { err = e; }
    expect(err && err.caseTransferOff).toBe(true);
    expect(browser(realApi).caseTransferKnownOutcome(err).status).toBe('Failed — not on the destination');
  });

  test('THE TORN STATE: the lock held elsewhere — the real route writes the subtype, the advance 409s with the torn message, the browser reads a FAILURE, and a new transfer card points at the move card', async () => {
    const c = await card({ kind: 'case.pipeline.transfer.v1', case_id: C2, pipeline: 'Chapter 13', evidence: cite(2) });
    // C2 is at 'discharged', which Chapter 13 lacks: the page's default is its first main-lane stage.
    expect([c.to.stage_key, c.stage_defaulted]).toEqual(['retained', 'first_main']);
    const holder = await pool.getConnection();
    let res;
    try {
      const [[got]] = await holder.query('SELECT GET_LOCK(?, 0) AS ok', [`pipeline_case_${C2}`]);
      expect(got.ok).toBe(1);
      res = await call(app, 'POST', `/api/cases/${C2}/pipeline/move`, browser(realApi).caseTransferRequest(c).body);
    } finally {
      await holder.query('SELECT RELEASE_LOCK(?)', [`pipeline_case_${C2}`]);
      holder.release();
    }
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(`case type/subtype updated for "Chapter 13" but the stage advance failed (Pipeline advance already in progress for case ${C2} — retry) — retry the move`);
    // Written: the subtype. Not written: the stage log, the stage columns.
    expect(await caseRow(C2)).toMatchObject({ case_subtype: 'Chapter 13', pipeline_phase: 'case', case_status: 'Discharged' });
    expect((await logRows(C2)).map((r) => r.stage_key)).toEqual(['discharged']);
    // The browser: a FAILURE naming the torn state — never applied, never "nothing written".
    const known = browser(realApi).caseTransferKnownOutcome({ status: res.status, message: res.body.message, body: res.body });
    expect(known.status).toBe('Failed — partly written');
    expect(known.text).toMatch(/the case's type \/ subtype were changed for the "Chapter 13" pipeline, but the stage advance was refused/);
    // As the card said: the case resolves to Chapter 13 with its old stage off that pipeline …
    const pipe = await call(app, 'GET', `/api/cases/${C2}/pipeline`);
    expect([pipe.body.template.id, pipe.body.current.stage_key, pipe.body.stages.some((s) => s.stage_key === 'discharged')]).toEqual([3, 'discharged', false]);
    // … and finishing it is a stage move on Chapter 13, not another transfer.
    await expect(card({ kind: 'case.pipeline.transfer.v1', case_id: C2, pipeline: 'Chapter 13', evidence: cite(2) })).rejects.toThrow(
      /^Case 25-60002 already resolves to the Chapter 13 pipeline — a move along it is not a transfer: propose case.pipeline.move.v1/);
  }, 20000);

  test('THE CLICK PRECHECK over the real GETs passes a fresh card and refuses one whose destination stage changed', async () => {
    const c = await card({ kind: 'case.pipeline.transfer.v1', case_id: C1, pipeline: 'Chapter 13', stage: 'filed', evidence: cite(1) });
    const b = browser(realApi);
    await expect(b.caseTransferPrecheck(c)).resolves.toBe('');
    await q('UPDATE pipeline_stage_requirements SET stage_id = 31 WHERE id = 306');
    await expect(b.caseTransferPrecheck(c)).resolves.toMatch(/^The stages or steps of the Chapter 13 pipeline changed/);
    await q('UPDATE pipeline_stages SET active = 0 WHERE id = 33');
    await expect(b.caseTransferPrecheck(c)).resolves.toMatch(/^The destination stage Filed \(filed\) changed or is no longer active on Chapter 13/);
  });
});
