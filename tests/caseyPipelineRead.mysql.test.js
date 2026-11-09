// tests/caseyPipelineRead.mysql.test.js
//
/**
 * A9.2 on REAL MySQL: the typed case.pipeline read (assistantService
 * casePipelineRead) over the services it reads through — caseService.getCase
 * and pipelineService.getPipeline with requirements, i.e. the real resolver
 * (requirementService.resolveRequirements, the manual and form detectors) —
 * over rows mysql2 really returns, under the production sql_mode, and against
 * the native route it mirrors (routes/api.pipeline.js GET
 * /api/cases/:id/pipeline?requirements=1, real handler, real pool).
 *
 * ── GATED ON YC_TEST_MYSQL_URL — SKIPPED OTHERWISE ──────────────────────────
 *   YC_TEST_MYSQL_URL=mysql://root@127.0.0.1:3378/yc_a92_test npx jest tests/caseyPipelineRead.mysql.test.js --runInBand
 * The database name must end in _test; this suite DROPS and recreates its
 * tables in it, cloned from ref/database.sql (live types and keys; a clause
 * referencing a table outside the list is dropped). Drops run with
 * FOREIGN_KEY_CHECKS off in the before-hook AND the after-hook and take any
 * sibling-built child of ours with them (the caseyPipeline.mysql hygiene).
 * It builds the same pipeline tables as tests/caseyPipeline.mysql.test.js:
 * give each its own *_test DB, or run them in one DB only one after the other.
 *
 * WHAT IS LOCKED
 *   - The resolver's statuses arrive verbatim: a detector-done step (a real
 *     form submission, with its satisfied_at and detail), a skipped one, an
 *     N/A override with its note / setter / time, the current stage's
 *     required and optional steps 'active', a later stage's 'upcoming'; an
 *     inactive requirement and (retained case) the Intake pipeline's steps
 *     are absent; `required` arrives as 1/0 from a TINYINT.
 *   - Both lanes: the off-ramp is a stage row (lane offramp) and is never
 *     `upcoming`; is_current / times_entered come from the real history.
 *   - The read and the route agree, status for status.
 *   - An intake lead: the Intake pipeline's stages (its inactive `retained`
 *     row is not one) plus the R2.5 projection's stages as projected_stage
 *     rows; no history = NO STAGE YET, every step upcoming.
 *   - A retained case no chapter pipeline matches: RETAINED CASE ON THE
 *     INTAKE PIPELINE (phase_mismatch 1), the generic projection.
 *   - No active Intake pipeline at all: NO PIPELINE, no stage rows.
 *   - An unknown case: the route's own 404 wording, as a not_found row.
 *   - A case id typed in the wrong case resolves to the canonical case and
 *     still carries its steps (getPipeline keys the steps by the id it is
 *     given; the read passes the stored one).
 *   - The A9 card refuses the advance over exactly the step the read shows
 *     as required and active.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const mysql = require('mysql2/promise');

// The route's auth gate is not under test here (the posture is pinned in
// tests/caseyPipelineRead.test.js with the REAL jwtOrApiKey).
jest.mock('../lib/auth.jwtOrApiKey', () => (req, _res, next) => { req.auth = { type: 'jwt', userId: 6 }; next(); });
const { casePipelineRead, normalizeActionDraft } = require('../services/assistantService');

const URL_ = process.env.YC_TEST_MYSQL_URL;
const d = URL_ ? describe : describe.skip;
// Production SESSION sql_mode (verified live 2026-09-25; CLAUDE.md "SQL mode is relaxed").
const PROD_SQL_MODE = 'IGNORE_SPACE,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
// contacts / case_relate: the A9 card's own getCase(…, 'contacts') read, in the two card tests.
const TABLES = ['cases', 'contacts', 'case_relate', 'pipeline_templates', 'pipeline_stages', 'pipeline_stage_requirements',
  'case_stage_log', 'case_requirement_overrides', 'form_submissions'];

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

function call(app, method, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app).listen(0, () => {
      const req = http.request({ port: srv.address().port, path: urlPath, method }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { srv.close(); resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); });
      });
      req.on('error', (e) => { srv.close(); reject(e); });
      req.setTimeout(10000, () => req.destroy(new Error('route call timed out')));
      req.end();
    });
  });
}

d('the case.pipeline read on real MySQL (A9.2)', () => {
  let pool; let app;
  const q = async (sql, p) => (await pool.query(sql, p))[0];
  const P1 = 'A92CASE01'; const P2 = 'A92CASE02'; const P3 = 'A92CASE03'; const P4 = 'A92CASE04';

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
    await q(`INSERT INTO pipeline_templates (id, name, case_type, case_subtype, role, is_default, active) VALUES
      (1, 'Intake', '', '', 'intake', 0, 1), (2, 'Chapter 7', 'Bankruptcy', 'Chapter 7', 'case', 1, 1)`);
    // Intake's own `retained` row is INACTIVE, as live (pipelineService PROJECTION_GENERIC_STAGE_KEY).
    await q(`INSERT INTO pipeline_stages (id, template_id, stage_key, stage_number, internal_label, client_label, case_stage, lane, default_rec, client_visible, is_terminal, active) VALUES
      (11, 1, 'consult_booked', 1, 'Consult booked', 'Consult', 'Open', 'main', 'Hold the consult', 1, 0, 1),
      (12, 1, 'consult_done', 2, 'Consult done', 'Consult done', 'Open', 'main', 'Send the contract', 1, 0, 1),
      (13, 1, 'contract_sent', 3, 'Contract sent', 'Contract sent', 'Open', 'main', '', 1, 0, 1),
      (14, 1, 'retained', 4, 'Retained', 'Retained', 'Open', 'main', '', 1, 0, 0),
      (19, 1, 'dead_lead', 91, 'Dead lead', NULL, 'Closed', 'offramp', '', 0, 1, 1),
      (21, 2, 'retained', 1, 'Retained', 'Retained', 'Open', 'main', 'Request documents', 1, 0, 1),
      (22, 2, 'docs', 2, 'Docs requested', 'Documents', 'Open', 'main', 'Chase paystubs', 1, 0, 1),
      (23, 2, 'filed', 3, 'Filed', 'Filed', 'Filed', 'main', '', 1, 0, 1),
      (29, 2, 'dismissed', 90, 'Dismissed', 'Dismissed', 'Closed', 'offramp', '', 1, 1, 1)`);
    await q(`INSERT INTO pipeline_stage_requirements (id, stage_id, requirement_key, internal_label, client_label, required, owner, kind, hint, detector, detector_config, sort_order, active) VALUES
      (301, 11, 'questionnaire', 'Intake questionnaire submitted', 'Questionnaire', 1, 'client', 'task', NULL, 'manual', NULL, 1, 1),
      (302, 11, 'courtesy', 'Courtesy call', NULL, 0, 'staff', 'task', NULL, 'manual', NULL, 2, 1),
      (401, 21, 'fee', 'Retainer fee paid', 'Fee', 1, 'client', 'task', NULL, 'manual', NULL, 1, 1),
      (402, 21, 'ch7_form', 'Chapter 7 form submitted', NULL, 1, 'client', 'task', NULL, 'form', '{"form_key":"ch7intake"}', 2, 1),
      (403, 21, 'engagement', 'Engagement letter sent', NULL, 1, 'staff', 'task', NULL, 'manual', NULL, 3, 1),
      (404, 22, 'paystubs', 'Paystubs received', 'Paystubs', 1, 'client', 'task', 'Six months of stubs', 'manual', NULL, 1, 1),
      (405, 22, 'call', 'Check-in call', NULL, 0, 'staff', 'event', NULL, 'manual', NULL, 2, 1),
      (406, 22, 'retired', 'Retired step', NULL, 1, 'client', 'task', NULL, 'manual', NULL, 3, 0),
      (407, 23, 'petition', 'Petition signed', NULL, 1, 'client', 'task', NULL, 'manual', NULL, 1, 1)`);
    await q(`INSERT INTO cases (case_id, case_number, case_number_full, case_type, case_subtype, pipeline_phase, case_stage, case_status, case_rec) VALUES
      (?, '25-50001', '25-50001-abc', 'Bankruptcy', 'Chapter 7', 'case', 'Open', 'Docs requested', 'Chase paystubs'),
      (?, NULL, NULL, 'Bankruptcy', 'Chapter 7', 'intake', 'Open', 'Consult booked', 'Hold the consult'),
      (?, '25-50003', NULL, 'Litigation', '', 'case', 'Open', 'Retained', ''),
      (?, NULL, NULL, 'Bankruptcy', '', 'intake', 'Open', 'New lead', '')`, [P1, P2, P3, P4]);
    await q(`INSERT INTO case_stage_log (id, case_id, template_id, stage_id, stage_key, case_stage, status_label, entered_at, entered_by, source, note) VALUES
      (1, ?, 1, 11, 'consult_booked', 'Open', 'Consult booked', '2026-10-01 10:00:00', 6, 'manual', NULL),
      (2, ?, 2, 21, 'retained', 'Open', 'Retained', '2026-10-05 10:00:00', 6, 'manual', NULL),
      (3, ?, 2, 22, 'docs', 'Open', 'Docs requested', '2026-10-06 15:30:00', 1, 'system', 'Docs list sent'),
      (4, ?, 1, 11, 'consult_booked', 'Open', 'Consult booked', '2026-10-07 09:00:00', 6, 'manual', NULL),
      (5, ?, 1, 13, 'contract_sent', 'Open', 'Contract sent', '2026-10-08 09:00:00', 6, 'manual', NULL)`, [P1, P1, P1, P2, P3]);
    await q(`INSERT INTO case_requirement_overrides (id, case_id, requirement_key, status, note, set_by, updated_at) VALUES
      (1, ?, 'fee', 'na', 'Paid at the consult, before the pipeline', 6, '2026-10-05 11:00:00')`, [P1]);
    await q(`INSERT INTO form_submissions (form_key, link_type, link_id, status, version, data, created_at) VALUES
      ('ch7intake', 'case', ?, 'submitted', 1, '{}', '2026-10-04 12:00:00'),
      ('ch7intake', 'case', ?, 'draft', 2, '{}', '2026-10-09 12:00:00')`, [P1, P1]);
  }
  const of = (rows, type) => rows.filter((r) => r.row_type === type);

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
    app.use((req, _res, next) => { req.db = pool; next(); });
    app.use(require('../routes/api.pipeline'));
  });

  afterAll(async () => {
    if (!pool) return;
    const conn = await pool.getConnection();
    try { await dropAll(conn); } finally { conn.release(); }
    await pool.end();
  });

  beforeEach(async () => { await seed(); });

  test('a retained case: the resolver\'s statuses verbatim — done, skipped, N/A override, active required and optional, upcoming', async () => {
    const out = await casePipelineRead(pool, P1);
    expect(out.truncated).toBe(false);
    const reqs = of(out.rows, 'requirement');
    expect(reqs.map((r) => [r.stage_key, r.requirement_key, r.required, r.status])).toEqual([
      ['retained', 'fee', 1, 'na'],
      ['retained', 'ch7_form', 1, 'done'],
      ['retained', 'engagement', 1, 'skipped'],
      ['docs', 'paystubs', 1, 'active'],
      ['docs', 'call', 0, 'active'],
      ['filed', 'petition', 1, 'upcoming'],
    ]);
    const [fee, form, , stubs] = reqs;
    // The override, whole: status, note, who, when.
    expect([fee.override_status, fee.override_note, fee.override_set_by, fee.override_at.toISOString(), fee.satisfied_at])
      .toEqual(['na', 'Paid at the consult, before the pipeline', 6, '2026-10-05T11:00:00.000Z', null]);
    // The detector's own fact: the SUBMITTED row (the later draft never satisfies).
    expect([form.satisfied_at.toISOString(), form.detail, form.override_status]).toEqual(['2026-10-04T12:00:00.000Z', 'Submitted', null]);
    expect([stubs.requirement_label, stubs.client_label, stubs.owner, stubs.kind, stubs.hint, stubs.stage_label])
      .toEqual(['Paystubs received', 'Paystubs', 'client', 'task', 'Six months of stubs', 'Docs requested']);
    // The Intake pipeline's step of a retained case and the inactive step are not listed.
    expect(reqs.map((r) => r.requirement_key)).not.toEqual(expect.arrayContaining(['questionnaire']));
    expect(reqs.map((r) => r.requirement_key)).not.toEqual(expect.arrayContaining(['retired']));
    expect(of(out.rows, 'projected_stage')).toEqual([]);
  });

  test('both lanes, the position and the history', async () => {
    const out = await casePipelineRead(pool, P1);
    expect(of(out.rows, 'stage').map((s) => [s.stage_key, s.lane, s.stage_number, s.is_current, s.upcoming, s.times_entered, s.requirements, s.is_terminal]))
      .toEqual([
        ['retained', 'main', 1, 0, 0, 1, 3, 0],
        ['docs', 'main', 2, 1, 0, 1, 2, 0],
        ['filed', 'main', 3, 0, 1, 0, 1, 0],
        ['dismissed', 'offramp', 90, 0, 0, 0, 0, 1],
      ]);
    const docs = of(out.rows, 'stage')[1];
    expect([docs.stage_label, docs.client_label, docs.case_stage, docs.default_rec, docs.last_entered_at.toISOString()])
      .toEqual(['Docs requested', 'Documents', 'Open', 'Chase paystubs', '2026-10-06T15:30:00.000Z']);
    const head = out.rows[0];
    expect(head).toMatchObject({
      row_type: 'case', case_id: P1, case_label: '25-50001-abc', case_number: '25-50001', pipeline_phase: 'case',
      case_stage: 'Open', case_status: 'Docs requested', case_rec: 'Chase paystubs',
      template_id: 2, template_name: 'Chapter 7', template_role: 'case', template_case_type: 'Bankruptcy', template_case_subtype: 'Chapter 7',
      phase_mismatch: 0, current_stage_key: 'docs', current_stage_label: 'Docs requested', current_lane: 'main',
      current_stage_number: 2, current_on_pipeline: 1, next_main_stage_key: 'filed', history_count: 3,
      last_entered_by: 1, last_source: 'system', last_note: 'Docs list sent', stages: 4, requirements: 6, projected_stages: 0,
    });
    expect(head.last_entered_at.toISOString()).toBe('2026-10-06T15:30:00.000Z');
    expect(head.note).toContain('The Chapter 7 pipeline (case) as the case page\'s Pipeline widget and Steps panel read it: 4 stages, both lanes');
    expect(head.note).toContain('The Intake pipeline\'s steps of a retained case are history and are not listed.');
    expect(head.note).not.toMatch(/NO STAGE YET|RETAINED CASE ON THE INTAKE|PROJECTION|NO PIPELINE/);
  });

  test('the read and the native route agree, step for step', async () => {
    const out = await casePipelineRead(pool, P1);
    const res = await call(app, 'GET', `/api/cases/${P1}/pipeline?requirements=1`);
    expect(res.status).toBe(200);
    const fromRoute = res.body.stages.flatMap((s) => s.requirements.map((r) => [s.stage_key, r.requirement_key, r.status, r.required]));
    const fromRead = of(out.rows, 'requirement').map((r) => [r.stage_key, r.requirement_key, r.status, r.required]);
    expect(fromRead).toEqual(fromRoute);
    expect(of(out.rows, 'stage').map((s) => s.stage_key)).toEqual(res.body.stages.map((s) => s.stage_key));
  });

  test('an intake lead: the Intake stages (not its inactive retained row) and the projection of the pipeline its subtype names', async () => {
    const out = await casePipelineRead(pool, P2);
    expect(of(out.rows, 'stage').map((s) => [s.stage_key, s.lane, s.is_current, s.upcoming]))
      .toEqual([['consult_booked', 'main', 1, 0], ['consult_done', 'main', 0, 1], ['contract_sent', 'main', 0, 1], ['dead_lead', 'offramp', 0, 0]]);
    expect(of(out.rows, 'requirement').map((r) => [r.requirement_key, r.status])).toEqual([['questionnaire', 'active'], ['courtesy', 'active']]);
    expect(of(out.rows, 'projected_stage').map((s) => [s.projected_source, s.projected_template, s.stage_key, s.lane]))
      .toEqual([['subtype', 'Chapter 7', 'retained', 'main'], ['subtype', 'Chapter 7', 'docs', 'main'], ['subtype', 'Chapter 7', 'filed', 'main']]);
    expect(out.rows[0]).toMatchObject({ case_label: P2, pipeline_phase: 'intake', template_role: 'intake', phase_mismatch: 0, next_main_stage_key: 'consult_done', projected_stages: 3 });
    expect(out.rows[0].note).toContain('PROJECTION: the case\'s subtype names the Chapter 7 pipeline');
    expect(out.rows[0].note).not.toContain('The Intake pipeline\'s steps of a retained case');
  });

  test('no history: NO STAGE YET — every step upcoming, nothing current', async () => {
    const out = await casePipelineRead(pool, P4);
    expect(of(out.rows, 'requirement').map((r) => r.status)).toEqual(['upcoming', 'upcoming']);
    expect(of(out.rows, 'stage').map((s) => s.is_current)).toEqual([0, 0, 0, 0]);
    expect(out.rows[0]).toMatchObject({ current_stage_key: null, current_on_pipeline: null, history_count: 0, last_entered_at: null, next_main_stage_key: 'consult_booked' });
    expect(out.rows[0].note).toContain('NO STAGE YET: the case has no pipeline history');
    // A blank subtype names no chapter pipeline: only the generic Retained row.
    expect(of(out.rows, 'projected_stage').map((s) => [s.projected_source, s.projected_template, s.stage_key])).toEqual([['generic', null, 'retained']]);
  });

  test('a retained case no chapter pipeline matches: RETAINED CASE ON THE INTAKE PIPELINE, flagged the way the A9 card refuses it', async () => {
    const out = await casePipelineRead(pool, P3);
    expect(out.rows[0]).toMatchObject({ pipeline_phase: 'case', template_name: 'Intake', template_role: 'intake', phase_mismatch: 1, current_stage_key: 'contract_sent' });
    expect(out.rows[0].note).toContain('RETAINED CASE ON THE INTAKE PIPELINE: the case\'s pipeline phase is "case" but no chapter pipeline matches its type/subtype (Litigation / no subtype), so it shows the Intake pipeline.');
    await expect(normalizeActionDraft(pool, { kind: 'case.pipeline.advance.v1', case_id: P3, evidence: [{ query_id: 'q1', row_number: 1 }] },
      [{ id: 'q1', kind: 'case.pipeline', rows: out.rows }], { currentUserId: 6 }))
      .rejects.toThrow(/is retained \(pipeline phase "case"\) but no chapter pipeline matches its type\/subtype \(Litigation \/ no subtype\)/);
  });

  test('no active Intake pipeline at all: NO PIPELINE, no stage rows', async () => {
    await q('UPDATE pipeline_templates SET active = 0');
    const out = await casePipelineRead(pool, P1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ row_type: 'case', case_id: P1, template_id: null, template_name: null, stages: 0, requirements: 0, history_count: 3, current_stage_key: 'docs', current_on_pipeline: 0 });
    expect(out.rows[0].note).toBe('NO PIPELINE: no pipeline resolves for case 25-50001-abc (no active Intake pipeline exists), so it has no stages and no steps — there is nothing to advance or move it along.');
  });

  test('an unknown case: the route\'s 404 wording', async () => {
    const res = await call(app, 'GET', '/api/cases/NOPE0001/pipeline?requirements=1');
    expect([res.status, res.body.message]).toEqual([404, 'Case NOPE0001 not found']);
    expect(await casePipelineRead(pool, 'NOPE0001')).toEqual({ rows: [{ row_type: 'not_found', case_id: 'NOPE0001', note: 'Case NOPE0001 not found' }], truncated: false });
  });

  test('a case id typed in the wrong case resolves to the stored case and keeps its steps', async () => {
    const out = await casePipelineRead(pool, P1.toLowerCase());
    expect(out.rows[0].case_id).toBe(P1);
    expect(of(out.rows, 'requirement')).toHaveLength(6);
    expect(of(out.rows, 'requirement').every((r) => r.case_id === P1)).toBe(true);
  });

  test('the A9 card refuses the advance over exactly the step the read shows required and active', async () => {
    const out = await casePipelineRead(pool, P1);
    const blocking = of(out.rows, 'requirement').filter((r) => r.required === 1 && (r.status === 'active' || r.status === 'upcoming') && r.stage_key === 'docs');
    expect(blocking.map((r) => r.requirement_label)).toEqual(['Paystubs received']);
    await expect(normalizeActionDraft(pool, { kind: 'case.pipeline.advance.v1', case_id: P1, evidence: [{ query_id: 'q1', row_number: 1 }] },
      [{ id: 'q1', kind: 'case.pipeline', rows: out.rows }], { currentUserId: 6 }))
      .rejects.toThrow('would pass over 1 required step that is not done: "Paystubs received" (stage Docs requested, active, client)');
  });
});
