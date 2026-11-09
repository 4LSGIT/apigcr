'use strict';
/**
 * tests/caseyPipelineTransfer.test.js
 *
 * A9.3 — Casey moves ONE case onto ANOTHER pipeline at ONE stage through a
 * reviewed card: case.pipeline.transfer.v1 → POST /api/cases/:id/pipeline/move
 * {template_id, stage_id, note?} (the case page's own "Move to another
 * pipeline…", pipelineService.movePipeline: the type / subtype write, then the
 * advance by stage id).
 *
 * The contract pinned here (mocked services; the real SQL, the real resolver,
 * the real route and its torn state run in tests/caseyPipelineTransfer.mysql.test.js):
 *   1. the casey_case_pipeline_enabled switch (A9's — no new key);
 *   2. key refusals: override keys, template_id / stage_id / case_type (the
 *      server derives them), missing pipeline, bad note / stage, evidence;
 *   3. the destination: by id or name, unknown / ambiguous / inactive refused,
 *      the pipeline the case resolves to now refused (that is the move card);
 *   4. the stage: key or label on the DESTINATION, inactive / unknown refused,
 *      the case page's default when unnamed (same key, else first main lane,
 *      else first off-ramp);
 *   5. the membership write exactly as movePipeline computes it (only the
 *      columns that differ; an intake destination writes none, keeps the
 *      subtype; a blank-subtype matter pipeline clears it);
 *   6. the RESOLVER DRY-RUN: a destination the post-state does not resolve to
 *      is refused (no case type, a second intake template, a duplicate that
 *      loses on id), and the advance's noop keeps the phase;
 *   7. PASSED-OVER REQUIREMENTS on the destination, projected the resolver's
 *      way (override → detector → position) — DISCLOSED as danger, never
 *      refused; the open required steps the old pipeline leaves;
 *   8. both events dry-run on their exact envelopes (case.updated source
 *      'pipeline_move'; case.stage_advanced with the POST type / subtype and the
 *      route's default note);
 *   9. `expected`; the ledger receipt; the request detector;
 *  10. the browser half (lifted from public/assistant.html by name): the fixed
 *      request, the four-read precheck, the result check, the torn state as a
 *      FAILURE, the noop and the lock 409 as refusals.
 *
 *   npx jest tests/caseyPipelineTransfer.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const pipelineService = require(path.join(REPO, 'services', 'pipelineService'));
const pipelineAdmin = require(path.join(REPO, 'services', 'pipelineAdminService'));
const detectors = require(path.join(REPO, 'services', 'requirementDetectors'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;
const REAL_GET_DETECTOR = detectors.getDetector;

const CASE_ID = '7KQ2M9XA';
const T = (id, name, role, type, sub, isDefault = 0, active = 1) => ({ id, name, role, case_type: type, case_subtype: sub, is_default: isDefault, active });
const INTAKE = T(1, 'Intake', 'intake', '', '');
const CH7 = T(2, 'Chapter 7', 'case', 'Bankruptcy', 'Chapter 7', 1);
const CH13 = T(3, 'Chapter 13', 'case', 'Bankruptcy', 'Chapter 13');
const OLD11 = T(4, 'Old Chapter 11', 'case', 'Bankruptcy', 'Chapter 11', 0, 0);
const LIT = T(5, 'Civil Litigation', 'case', 'Litigation', '', 1);
const BLANK = T(6, 'Misc', 'case', '', '');
const TEMPLATES = () => [INTAKE, CH7, CH13, OLD11, LIT, BLANK].map((t) => ({ ...t }));

// pipelineAdminService.listStages rows (all stages, both lanes, inactive too).
const S = (id, tid, key, label, num, over = {}) => ({ id, template_id: tid, stage_key: key, internal_label: label, stage_number: num, client_label: `${label} (client)`,
  client_visible: 1, case_stage: 'Open', lane: 'main', default_rec: `Next: ${label}`, active: 1, req_count: 0, log_count: 0, ...over });
const STAGES = {
  1: () => [S(11, 1, 'consult_booked', 'Consult booked', 1), S(12, 1, 'consult_done', 'Consult done', 2), S(13, 1, 'contract_sent', 'Contract sent', 3),
    S(19, 1, 'dead_lead', 'Dead lead', 91, { lane: 'offramp', client_visible: 0 })],
  3: () => [S(31, 3, 'retained', 'Retained', 1, { req_count: 2 }), S(32, 3, 'docs', 'Docs requested', 2, { req_count: 2 }),
    S(33, 3, 'filed', 'Filed', 3, { case_stage: 'Filed', default_rec: 'Await the plan hearing', req_count: 1 }), S(34, 3, 'confirmed', 'Plan confirmed', 4),
    S(36, 3, 'hearing', 'Old hearing', 5, { active: 0 }), S(39, 3, 'dismissed', 'Dismissed', 90, { lane: 'offramp', case_stage: 'Closed', client_visible: 0 })],
  5: () => [S(51, 5, 'opened', 'Opened', 1), S(52, 5, 'filed', 'Complaint filed', 2, { case_stage: 'Filed' })],
  6: () => [S(61, 6, 'start', 'Start', 1)],
};
// pipeline_stage_requirements rows (the normalizer's own SELECT, active only).
const R = (id, stageId, key, label, required, over = {}) => ({ id, stage_id: stageId, requirement_key: key, internal_label: label, required, owner: 'client', detector: 'manual', active: 1, sort_order: id, ...over });
const REQS = () => [
  R(301, 31, 'fee', 'Retainer fee paid', 1), R(302, 31, 'courtesy', 'Courtesy call', 0, { owner: 'staff' }),
  R(303, 32, 'w2', 'W-2s received', 1), R(304, 32, 'credit', 'Credit report pulled', 1, { detector: 'stub', owner: 'staff' }),
  R(305, 33, 'plan_filed', 'Plan filed', 1),
];

// The case's CURRENT pipeline (getPipeline {requirements:true}): Chapter 7 at filed.
const CH7_PIPE = () => ({
  template: { id: 2, name: 'Chapter 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
  current: { stage_id: 23, stage_key: 'filed', case_stage: 'Filed', status_label: 'Filed', entered_at: new Date('2026-10-01T12:00:00Z'), entered_by: 6, source: 'manual', note: null },
  history: [{ stage_key: 'retained' }, { stage_key: 'filed' }],
  stages: [
    { stage_id: 21, stage_key: 'retained', stage_number: 1, internal_label: 'Retained', lane: 'main', requirements: [] },
    { stage_id: 23, stage_key: 'filed', stage_number: 3, internal_label: 'Filed', lane: 'main', requirements: [
      { requirement_key: 'cc_cert', stage_id: 23, internal_label: 'Credit counseling certificate', required: 1, owner: 'client', status: 'active' },
      { requirement_key: 'opt', stage_id: 23, internal_label: 'Optional thing', required: 0, owner: 'staff', status: 'active' }] },
  ],
  upcoming: [],
});
const INTAKE_PIPE = (at = 'contract_sent') => ({
  template: { id: 1, name: 'Intake', role: 'intake', case_type: '', case_subtype: '' },
  current: at ? { stage_id: 13, stage_key: at, status_label: 'Contract sent' } : null,
  history: at ? [{ stage_key: at }] : [],
  stages: [
    { stage_id: 11, stage_key: 'consult_booked', stage_number: 1, internal_label: 'Consult booked', lane: 'main', requirements: [
      { requirement_key: 'questionnaire', stage_id: 11, internal_label: 'Intake questionnaire submitted', required: 1, owner: 'client', status: at ? 'skipped' : 'upcoming' }] },
    { stage_id: 13, stage_key: 'contract_sent', stage_number: 3, internal_label: 'Contract sent', lane: 'main', requirements: [
      { requirement_key: 'contract_signed', stage_id: 13, internal_label: 'Retainer contract signed', required: 1, owner: 'client', status: at ? 'active' : 'upcoming' }] },
  ],
  upcoming: [],
});

let spies = [];
const queries = [];
function setup({ caseRow = {}, pipe = CH7_PIPE(), templates = TEMPLATES(), stages = STAGES, reqs = REQS(), overrides = [{ requirement_key: 'w2', status: 'na' }],
  latest = { template_id: 2, stage_key: 'filed' }, rules = {}, stubDone = ['credit'] } = {}) {
  const row = { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
    pipeline_phase: 'case', case_stage: 'Filed', case_status: 'Filed', case_rec: 'Wait for the 341', case_chapter: '7', ...caseRow };
  queries.length = 0;
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id, include) => {
      expect(include).toBe('contacts');
      if (String(id) !== CASE_ID) return null;
      return { case: { ...row }, clients: [{ contact_name: 'Dana Debtor', relate_type: 'Primary' }, { contact_name: 'Opp Counsel', relate_type: 'Other' }] };
    }),
    jest.spyOn(pipelineService, 'getPipeline').mockImplementation(async (_db, id, opts) => {
      expect([id, opts]).toEqual([CASE_ID, { requirements: true }]);
      return JSON.parse(JSON.stringify(pipe));
    }),
    jest.spyOn(pipelineAdmin, 'listTemplates').mockImplementation(async () => templates.map((t) => ({ ...t }))),
    jest.spyOn(pipelineAdmin, 'listStages').mockImplementation(async (_db, tid) => ({ template: templates.find((t) => t.id === tid), stages: (stages[tid] || (() => []))() })),
    // A test-only detector kind ('stub'): satisfied for the keys listed; every
    // real kind ('manual') stays the real registry's.
    jest.spyOn(detectors, 'getDetector').mockImplementation((kind) => (kind === 'stub' ? {
      batchResolve: async (_db, ids, list) => new Map([[ids[0], new Map(list.filter((r) => stubDone.includes(r.requirement_key)).map((r) => [r.requirement_key, { satisfied_at: new Date('2026-10-02T00:00:00Z') }]))]]),
    } : REAL_GET_DETECTOR(kind))),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => (rules[ev] || [])),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    queries.push(flat);
    if (flat === 'SELECT * FROM pipeline_templates WHERE active = 1 ORDER BY id ASC') return [templates.filter((t) => t.active).sort((a, b) => a.id - b.id)];
    if (flat === 'SELECT template_id, stage_key FROM case_stage_log WHERE case_id = ? ORDER BY entered_at DESC, id DESC LIMIT 1') {
      expect(params).toEqual([CASE_ID]);
      return [latest ? [latest] : []];
    }
    if (flat === 'SELECT * FROM pipeline_stage_requirements WHERE stage_id IN (?) AND active = 1 ORDER BY sort_order ASC, id ASC') {
      return [reqs.filter((r) => params[0].includes(r.stage_id))];
    }
    if (flat === 'SELECT requirement_key, status FROM case_requirement_overrides WHERE case_id = ?') {
      expect(params).toEqual([CASE_ID]);
      return [overrides];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CASE_PIPELINE_ENABLED; });

const EVIDENCE = [{ id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }, { case_id: 'OTHER123' }] }];
const transfer = (pipeline, over = {}) => ({ kind: 'case.pipeline.transfer.v1', case_id: CASE_ID, pipeline, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);

describe('the switch and the keys', () => {
  test("A9's switch: '0' makes the transfer unavailable too; unset is ON", async () => {
    process.env.CASEY_CASE_PIPELINE_ENABLED = '0';
    await expect(run(transfer('Chapter 13'))).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_CASE_PIPELINE_ENABLED;
    await expect(run(transfer('Chapter 13'))).resolves.toMatchObject({ kind: 'case.pipeline.transfer.v1', status: 'draft' });
  });

  test('an override key is refused by name before anything is read', async () => {
    for (const key of ['override', 'skip_requirements', 'force']) {
      await refuse(transfer('Chapter 13', { [key]: true }), new RegExp(`^REQUIREMENT OVERRIDE refused \\(${key}\\)`));
    }
    expect(caseService.getCase).not.toHaveBeenCalled();
  });

  test('template_id, stage_id, case_type and other keys are refused — the server derives them', async () => {
    for (const key of ['template_id', 'stage_id', 'case_type', 'case_subtype', 'extra']) {
      await refuse(transfer('Chapter 13', { [key]: 3 }), new RegExp(`^A pipeline transfer carries unsupported fields: ${key} — it takes case_id, pipeline, stage, note and evidence only`));
    }
  });

  test('shape refusals: case_id, pipeline, stage, note, evidence', async () => {
    await refuse(transfer('Chapter 13', { case_id: 'bad id!' }), /needs the case's exact case_id/);
    await refuse(transfer(''), /needs "pipeline": the destination pipeline's id or name/);
    await refuse(transfer(3.5), /needs "pipeline"/);
    await refuse(transfer('Chapter 13', { stage: 5 }), /"stage" names a stage of the destination pipeline/);
    await refuse(transfer('Chapter 13', { stage: '  ' }), /"stage" names a stage of the destination pipeline/);
    await refuse(transfer('Chapter 13', { note: 7 }), /The pipeline note must be text/);
    await refuse(transfer('Chapter 13', { note: 'x'.repeat(256) }), /The pipeline note is 256 characters — the stage log keeps 255/);
    await refuse(transfer('Chapter 13', { evidence: [{ query_id: 'q1', row_number: 2 }] }), /evidence does not identify case 7KQ2M9XA/);
  });

  test('an unknown case is refused', async () => {
    await refuse(transfer('Chapter 13', { case_id: 'NOPE1234' }), /^Case NOPE1234 no longer exists$/, undefined,
      [{ id: 'q1', rows: [{ case_id: 'NOPE1234' }] }]);
  });
});

describe('the destination pipeline', () => {
  test('by name (any capitalisation), by numeric id and by an all-digit string', async () => {
    for (const p of ['chapter 13', 3, '3']) await expect(run(transfer(p))).resolves.toMatchObject({ to: { template_id: 3, template_name: 'Chapter 13', template_role: 'case' } });
  });
  test('unknown, ambiguous and inactive pipelines are refused by name; the active ones are listed', async () => {
    await refuse(transfer('Chapter 99'), '"Chapter 99" is not a pipeline. The active pipelines are: Intake (#1), Chapter 7 (#2), Chapter 13 (#3), Civil Litigation (#5), Misc (#6)');
    await refuse(transfer(42), /^There is no pipeline #42 \(the move route answers "Unknown pipeline template"\)/);
    await refuse(transfer('Old Chapter 11'), 'The Old Chapter 11 pipeline (#4) is inactive — the move route refuses an inactive pipeline template');
    const twins = [...TEMPLATES(), T(9, 'chapter 13', 'case', 'Bankruptcy', 'Chapter 13 B')];
    await refuse(transfer('Chapter 13'), '"Chapter 13" names 2 pipelines: Chapter 13 (#3), chapter 13 (#9) — name it by its id', { templates: twins });
  });
  test('the pipeline the case resolves to now is the move card\'s job, said by name', async () => {
    await refuse(transfer('Chapter 7'), 'Case 25-12345-abc already resolves to the Chapter 7 pipeline — a move along it is not a transfer: propose case.pipeline.move.v1 naming the stage (or case.pipeline.advance.v1 for its next stage)');
  });
});

describe('the destination stage', () => {
  test('by key or label on the destination; unknown, ambiguous and inactive stages are refused', async () => {
    await expect(run(transfer('Chapter 13', { stage: 'CONFIRMED' }))).resolves.toMatchObject({ to: { stage_id: 34, stage_key: 'confirmed' }, stage_defaulted: null });
    await expect(run(transfer('Chapter 13', { stage: 'docs requested' }))).resolves.toMatchObject({ to: { stage_id: 32 } });
    await refuse(transfer('Chapter 13', { stage: 'consult_done' }),
      '"consult_done" is not a stage of the Chapter 13 pipeline — its stages are: Retained (retained), Docs requested (docs), Filed (filed), Plan confirmed (confirmed), Dismissed (dismissed)');
    await refuse(transfer('Chapter 13', { stage: 'hearing' }), /^The stage Old hearing \(hearing\) of the Chapter 13 pipeline is inactive — the move route refuses an inactive stage/);
    // A key wins over a label (A9's rule); two labels with no key match are ambiguous.
    const dup = { ...STAGES, 3: () => [...STAGES[3](), S(37, 3, 'confirmed_b', 'Plan confirmed', 6), S(38, 3, 'docs_b', 'docs', 7)] };
    await refuse(transfer('Chapter 13', { stage: 'Plan Confirmed' }), /^"Plan Confirmed" names 2 stages of the Chapter 13 pipeline: Plan confirmed \(confirmed\), Plan confirmed \(confirmed_b\) — name it by its key$/, { stages: dup });
    await expect(run(transfer('Chapter 13', { stage: 'docs' }), { stages: dup })).resolves.toMatchObject({ to: { stage_id: 32 } });
  });
  test('unnamed: the case page\'s default — the current stage key when the destination has it, else its first main-lane stage, else its first off-ramp', async () => {
    const same = await run(transfer('Chapter 13'));
    expect([same.to.stage_key, same.stage_defaulted]).toEqual(['filed', 'same_key']);
    expect(same.effects).toContain('Stage: not named — the case page\'s default, the case\'s current stage key "filed", which Chapter 13 has too.');
    const first = await run(transfer('Chapter 13'), { pipe: { ...CH7_PIPE(), current: { stage_key: 'converted', status_label: 'Converted' } }, latest: { template_id: 2, stage_key: 'converted' } });
    expect([first.to.stage_key, first.stage_defaulted]).toEqual(['retained', 'first_main']);
    // An off-ramp only when no main-lane stage is active (the inactive row is never a default).
    const litOff = { ...STAGES, 5: () => [S(51, 5, 'opened', 'Opened', 1, { active: 0 }), S(59, 5, 'settled', 'Settled', 9, { lane: 'offramp' })] };
    const lo = await run(transfer('Civil Litigation'), { stages: litOff });
    expect([lo.to.stage_key, lo.stage_defaulted, lo.to.lane]).toEqual(['settled', 'first_offramp', 'offramp']);
    expect(lo.warnings).toContain('OFF-RAMP: Settled (settled) is an off-ramp of Civil Litigation, not its main path.');
    const none = { ...STAGES, 5: () => [S(51, 5, 'opened', 'Opened', 1, { active: 0 })] };
    await refuse(transfer('Civil Litigation'), 'The Civil Litigation pipeline has no active stages — there is nowhere to put the case', { stages: none });
  });
});

describe('the membership write — exactly as movePipeline computes it', () => {
  test('Chapter 7 → Chapter 13: only the subtype differs, so only it is written; NOT ATOMIC is said', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'filed' }));
    expect(c.membership).toEqual({ case_subtype: { from: 'Chapter 7', to: 'Chapter 13' } });
    expect(c.warnings).toContain('CASE TYPE / SUBTYPE REWRITTEN: case_subtype "Chapter 7" → "Chapter 13" — the Chapter 13 pipeline\'s own values, written first through the case page\'s save (caseService), so case.updated fires for it.');
    expect(c.warnings.find((w) => /^NOT ATOMIC: two writes/.test(w))).toMatch(/the case is left resolving to Chapter 13 with its old stage position, shown off Chapter 13's stages; the route's own error says so and says to retry the move, and the result here reads as a failure naming it, never as applied/);
    expect(c.effects).toContain('Reads case_subtype: Pipeline: with case_type it picks the chapter pipeline (an exact match on both; a blank subtype matches none); the case page\'s Subtype select.');
  });
  test('a blank-subtype matter pipeline writes the type and CLEARS the subtype', async () => {
    const c = await run(transfer('Civil Litigation', { stage: 'filed' }));
    expect(c.membership).toEqual({ case_type: { from: 'Bankruptcy', to: 'Litigation' }, case_subtype: { from: 'Chapter 7', to: '' } });
    expect(c.warnings).toContain('CASE TYPE / SUBTYPE REWRITTEN: case_type "Bankruptcy" → "Litigation"; case_subtype "Chapter 7" → blank — the Civil Litigation pipeline\'s own values, written first through the case page\'s save (caseService), so case.updated fires for it.');
    expect(c.effects.some((e) => /^Reads case_type: CLIENT PORTAL/.test(e))).toBe(true);
  });
  test('the type compare is movePipeline\'s exact String compare: a capitalisation difference IS written', async () => {
    const c = await run(transfer('Chapter 13'), { caseRow: { case_type: 'bankruptcy' } });
    expect(Object.keys(c.membership)).toEqual(['case_type', 'case_subtype']);
  });
  test('an intake destination writes none and KEEPS the subtype; the phase goes back to intake (danger); no NOT ATOMIC line', async () => {
    const c = await run(transfer('Intake', { stage: 'consult_done' }));
    expect(c.membership).toEqual({});
    expect(c.effects).toContain('Type / subtype: not written — an intake pipeline is chosen by the phase alone, so the case KEEPS its type (Bankruptcy) and subtype (Chapter 7); the subtype feeds the look-ahead to its chapter pipeline. No case.updated fires for the move.');
    expect(c.warnings).toContain('LIFECYCLE — THE CASE GOES BACK TO INTAKE: pipeline phase case → intake. It is treated as a lead again everywhere (the board, the client portal\'s timeline, reports, every rule that reads the phase).');
    expect(c.warnings.some((w) => /^NOT ATOMIC/.test(w))).toBe(false);
    expect(c.writes.pipeline_phase).toEqual({ from: 'case', to: 'intake' });
    expect(c.automation.case_updated).toBe(null);
  });
  test('an intake lead onto a chapter pipeline is RETAINED (danger) and its open intake steps are said to read skipped', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'docs' }), { pipe: INTAKE_PIPE(), caseRow: { pipeline_phase: 'intake', case_subtype: 'Chapter 7' }, latest: { template_id: 1, stage_key: 'contract_sent' } });
    expect(c.warnings).toContain('LIFECYCLE — THIS RETAINS THE CASE: pipeline phase intake → case. It is treated as a retained case everywhere from now on (the board it sits on, the client portal\'s timeline, reports, every rule that reads the phase); its intake steps become history.');
    expect(c.warnings).toContain('REQUIRED STEPS LEFT ON INTAKE: 1 required step not done there: "Retainer contract signed" (stage Contract sent, active, client) — they read skipped once the case is retained (intake steps become history).');
    expect(c.from).toEqual({ stage_key: 'contract_sent', stage_id: 13, label: 'Contract sent', lane: 'main', on_pipeline: true });
  });
});

describe('the RESOLVER DRY-RUN — the post-state must resolve to the destination', () => {
  test('a matter pipeline with no case type writes nothing, so the case keeps resolving by its own: refused', async () => {
    await refuse(transfer('Misc'), 'PIPELINE DOES NOT RESOLVE: after this move case 25-12345-abc would resolve to the Chapter 7 pipeline, not Misc — Misc has no case type, so the move writes no type / subtype and the case keeps resolving by its own (Bankruptcy / Chapter 7). The move would file the case on a stage of a pipeline it does not resolve to (a phantom position: the case page and the board show it off its pipeline\'s stages). Casey does not do that; fix the pipeline templates or the case\'s type / subtype first');
  });
  test('a second active intake template never resolves: refused', async () => {
    const two = [...TEMPLATES(), T(7, 'Intake B', 'intake', '', '')];
    await refuse(transfer('Intake B'), /^PIPELINE DOES NOT RESOLVE: after this move case 25-12345-abc would resolve to the Intake pipeline, not Intake B — an intake case resolves to the first active intake pipeline \(Intake\), never to Intake B\./,
      { templates: two, stages: { ...STAGES, 7: () => [S(71, 7, 'lead', 'Lead', 1)] } });
  });
  test('a duplicate that loses to a lower id: refused, naming the winner', async () => {
    const dup = [...TEMPLATES(), T(8, 'Chapter 13 (new)', 'case', 'Bankruptcy', 'Chapter 13')];
    await refuse(transfer(8), /^PIPELINE DOES NOT RESOLVE: after this move case 25-12345-abc would resolve to the Chapter 13 pipeline, not Chapter 13 \(new\) — with type \/ subtype Bankruptcy \/ Chapter 13 the resolver picks Chapter 13 \(#3\) first\./,
      { templates: dup, stages: { ...STAGES, 8: () => [S(81, 8, 'filed', 'Filed', 1)] } });
  });
  test('the advance\'s noop (the latest entry already there) keeps the phase — the dry-run uses it; the card says no entry is written', async () => {
    // A phantom: the case resolves to Chapter 7 but its latest entry is Chapter 13 / filed.
    const c = await run(transfer('Chapter 13', { stage: 'filed' }), { latest: { template_id: 3, stage_key: 'filed' } });
    expect(c.noop_expected).toBe(true);
    expect(c.writes).toEqual({ case_stage: { from: 'Filed', to: 'Filed' }, case_status: { from: 'Filed', to: 'Filed' }, case_rec: { from: 'Wait for the 341', to: 'Wait for the 341' }, pipeline_phase: { from: 'case', to: 'case' } });
    expect(c.effects).toContain('Stage log: no new entry — the case\'s latest entry is already Filed (filed) on Chapter 13, so the advance writes nothing, flips no phase and fires no case.stage_advanced; only the type / subtype change.');
    expect(c.automation.stage_advanced).toBe(null);
    // The same phantom onto INTAKE: no membership write and no phase flip — it would resolve to Chapter 7 still.
    await refuse(transfer('Intake', { stage: 'contract_sent' }), /^PIPELINE DOES NOT RESOLVE: after this move case 25-12345-abc would resolve to the Chapter 7 pipeline, not Intake/,
      { latest: { template_id: 1, stage_key: 'contract_sent' } });
  });
});

describe('PASSED-OVER REQUIREMENTS on the destination — projected, DISCLOSED, never refused', () => {
  test('override → detector → position: the required step not done is a danger line, word for word; N/A and detector-done are satisfied; the optional one is listed', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'filed' }));
    expect(c.status).toBe('draft');
    expect(c.warnings).toContain('PASSED-OVER REQUIRED STEPS: landing at Filed (filed) on Chapter 13 passes over 1 required step that is not done or N/A: "Retainer fee paid" (stage Retained, skipped, client) — they will read skipped once the case is there (the case page\'s move allows it; Casey cannot mark a step done or N/A — the user can, on the case\'s Steps panel).');
    expect(c.requirements).toEqual({
      passed_required: [{ internal_label: 'Retainer fee paid', stage_label: 'Retained', status: 'skipped', owner: 'client' }],
      optional_skipped: [{ internal_label: 'Courtesy call', stage_label: 'Retained', status: 'skipped', owner: 'staff' }],
      satisfied: [{ internal_label: 'W-2s received', stage_label: 'Docs requested', status: 'na', owner: 'client' },
        { internal_label: 'Credit report pulled', stage_label: 'Docs requested', status: 'done', owner: 'staff' }],
      destination: [{ internal_label: 'Plan filed', required: 1, status: 'active' }],
      leaving_open: [{ internal_label: 'Credit counseling certificate', stage_label: 'Filed', status: 'active', owner: 'client' }],
    });
    expect(c.warnings).toContain('REQUIRED STEPS LEFT ON CHAPTER 7: 1 required step not done there: "Credit counseling certificate" (stage Filed, active, client) — they leave the case\'s step list (they belong to Chapter 7, which the case no longer resolves to).');
  });
  test('several passed-over steps are all named; a detector that is NOT satisfied leaves its step skipped; the first stage passes none', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'confirmed' }), { overrides: [], stubDone: [] });
    expect(c.requirements.passed_required.map((r) => r.internal_label)).toEqual(['Retainer fee paid', 'W-2s received', 'Credit report pulled', 'Plan filed']);
    expect(c.warnings.find((w) => /^PASSED-OVER/.test(w))).toMatch(/passes over 4 required steps that are not done or N\/A: "Retainer fee paid" \(stage Retained, skipped, client\); "W-2s received" \(stage Docs requested, skipped, client\); "Credit report pulled" \(stage Docs requested, skipped, staff\); "Plan filed" \(stage Filed, skipped, client\) —/);
    const first = await run(transfer('Chapter 13', { stage: 'retained' }));
    expect([first.requirements.passed_required, first.warnings.some((w) => /^PASSED-OVER/.test(w))]).toEqual([[], false]);
    expect(first.requirements.destination).toEqual([{ internal_label: 'Retainer fee paid', required: 1, status: 'active' }, { internal_label: 'Courtesy call', required: 0, status: 'active' }]);
  });
  test('an override of "done" on a destination step satisfies it; a destination with no steps reads none', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'filed' }), { overrides: [{ requirement_key: 'fee', status: 'done' }, { requirement_key: 'w2', status: 'na' }] });
    expect(c.requirements.passed_required).toEqual([]);
    const lit = await run(transfer('Civil Litigation', { stage: 'filed' }));
    expect(lit.requirements).toMatchObject({ passed_required: [], destination: [] });
  });
});

describe('downstream automation — both events, exact envelopes', () => {
  const rule = (id, name, event, match, actions) => ({ id, name, event_type: event, match_mode: 'conditions', match_config: match,
    transform_mode: 'passthrough', transform_config: null, min_interval_s: 0, cooling_down: 0, actions });
  test('case.updated (source pipeline_move) and case.stage_advanced (the POST subtype, the route\'s default note) are each dry-run and listed', async () => {
    const seen = [];
    const rules = {
      'case.updated': [rule(41, 'Subtype → Ch13 docs', 'case.updated', { operator: 'and', conditions: [{ path: 'changes.case_subtype.to', op: 'equals', value: 'Chapter 13' }] },
        [{ id: 1, name: null, action_type: 'workflow', config: { workflow_id: 77 } }])],
      'case.stage_advanced': [rule(42, 'Stage change → case log', 'case.stage_advanced', { operator: 'and', conditions: [{ path: 'extra.note', op: 'equals', value: 'Moved to "Chapter 13"' }] },
        [{ id: 2, name: 'Log it', action_type: 'internal_function', config: { function_name: 'create_log' } }])],
    };
    const db = setup({ rules });
    const real = triggerService.evaluateDraft;
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (r, env) => { seen.push(env); return real.call(triggerService, r, env); }));
    const c = await normalizeActionDraft(db, transfer('Chapter 13', { stage: 'filed' }), EVIDENCE, { currentUserId: 6 });
    expect(c.automation).toEqual({
      case_updated: { rules_checked: 1, quiet: 0, lines: ['Trigger rule #41 "Subtype → Ch13 docs" runs: starts workflow #77'] },
      stage_advanced: { rules_checked: 1, quiet: 0, lines: ['Trigger rule #42 "Stage change → case log" runs: calls create_log ("Log it")'] },
    });
    expect(seen[0]).toMatchObject({ event: 'case.updated', case_id: CASE_ID, source: 'pipeline_move', actor: { user_id: 6 },
      data: { case_subtype: 'Chapter 13', case_type: 'Bankruptcy' }, changes: { case_subtype: { from: 'Chapter 7', to: 'Chapter 13' } }, extra: { updated_fields: ['case_subtype'] } });
    expect(seen[1]).toMatchObject({ event: 'case.stage_advanced', source: 'manual', actor: { user_id: 6 },
      data: { stage_key: 'filed', stage_id: 33, template_id: 3, case_stage: 'Filed', status_label: 'Filed', case_type: 'Bankruptcy', case_subtype: 'Chapter 13' },
      extra: { from_stage: 'filed', from_template_id: 2, note: 'Moved to "Chapter 13"' } });
    expect(c.log_note).toBe('Moved to "Chapter 13"');
    expect(c.effects).toContain('Stage log: one new entry on Chapter 13, entered by you, with the note "Moved to "Chapter 13"" (the route\'s default); stage-age reminders restart from this entry.');
  });
  test('a given note rides the envelope and the log line; a rule that cannot be evaluated is a danger line', async () => {
    const db = setup({ rules: { 'case.stage_advanced': [rule(50, 'Code rule', 'case.stage_advanced', { operator: 'and', conditions: [] }, [])] } });
    const seen = [];
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (r, env) => { seen.push(env); return { matched: false, match_error: 'GUEST_CODE_BUSY' }; }));
    const c = await normalizeActionDraft(db, transfer('Chapter 13', { stage: 'filed', note: 'converted at the hearing' }), EVIDENCE, { currentUserId: 6 });
    expect(seen.find((e) => e.event === 'case.stage_advanced').extra.note).toBe('converted at the hearing');
    expect(c.warnings).toContain('AUTOMATION: at least one trigger rule could not be evaluated for this transfer — read its line; it may run.');
    expect(c.effects).toContain('Stage log: one new entry on Chapter 13, entered by you, with the note "converted at the hearing"; stage-age reminders restart from this entry.');
  });
  test('the four overwritten columns, the replaced next step and the portal line, as A9 shows them', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'filed' }));
    expect(c.writes).toEqual({ case_stage: { from: 'Filed', to: 'Filed' }, case_status: { from: 'Filed', to: 'Filed' }, case_rec: { from: 'Wait for the 341', to: 'Await the plan hearing' }, pipeline_phase: { from: 'case', to: 'case' } });
    expect(c.effects).toContain('Next step (case_rec) is REPLACED: "Wait for the 341" → "Await the plan hearing" — the stage\'s default; any hand-written next step is lost.');
    expect(c.effects).toContain('Client portal: the client\'s timeline shows "Filed (client)" as the case\'s current stage.');
    expect(c.warnings[0]).toBe('PIPELINE TRANSFER: case 25-12345-abc leaves the Chapter 7 pipeline for Chapter 13, at Filed (filed) — there is no undo (moving it back is another transfer).');
  });
});

describe('expected, the ledger, the request detector', () => {
  test('expected carries the case, its position, the destination, its stage list and the resolver\'s inputs', async () => {
    const c = await run(transfer('Chapter 13', { stage: 'filed' }));
    expect(c.expected).toEqual({
      case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case', case_stage: 'Filed',
      template_id: 2, stage_key: 'filed', history_count: 2,
      dest_template_id: 3, dest_active: 1, dest_role: 'case', dest_case_type: 'Bankruptcy', dest_case_subtype: 'Chapter 13', dest_stage_id: 33,
      dest_stages: ['31:retained:1:main:2', '32:docs:2:main:2', '33:filed:3:main:1', '34:confirmed:4:main:0', '39:dismissed:90:offramp:0'],
      templates: ['1:intake:::0', '2:case:Bankruptcy:Chapter 7:1', '3:case:Bankruptcy:Chapter 13:0', '5:case:Litigation::1', '6:case:::0'],
    });
    expect(c.case).toEqual({ case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', clients: ['Dana Debtor'] });
    expect(c.pipeline).toEqual({ template_id: 2, name: 'Chapter 7', role: 'case' });
  });
  test('the receipt is the STRING case_id', () => {
    expect(ledger.KINDS.get('case.pipeline.transfer.v1')).toBe('case_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('case_id')).toBe(true);
  });
  test.each([
    ['transfer the Smith case to Chapter 13', true],
    ['switch this case to chapter 13', true],
    ['move the lead back to intake', true],
    ['transfer it to the Chapter 13 pipeline at filed', true],
    ['which pipeline is the Smith case on?', false],
    ['how many cases are on chapter 13?', false],
  ])('%s → %s', (q, want) => {
    expect(taskDraftRequested(q)).toBe(want);
  });
});

// ── The browser half, lifted from public/assistant.html by name ───────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
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
function constSrc(name) {
  const m = new RegExp(`const\\s+${name}\\s*=`).exec(html);
  if (!m) throw new Error(`const ${name} not found`);
  return html.slice(m.index, html.indexOf(';\n', m.index) + 1);
}
const FNS = ['actionStringReceipt', 'casePipelineCaseLabel', 'casePipelineStageName', 'caseTransferText', 'caseTransferRequest', 'caseTransferPrecheck',
  'caseTransferResult', 'caseTransferKnownOutcome'];
function browser(api) {
  const src = [constSrc('CASE_TRANSFER_TORN'), ...FNS.map(fnSrc), `return { ${FNS.join(', ')} };`].join('\n');
  return new Function('api', src)(api); // eslint-disable-line no-new-func
}

describe('the browser: request, precheck, result, outcomes', () => {
  let card;
  beforeAll(async () => { card = await run(transfer('Chapter 13', { stage: 'filed', note: 'converted' })); spies.forEach((s) => s.mockRestore()); spies = []; });
  const caseRead = (over = {}) => ({ status: 'success', case: { case_id: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case', case_stage: 'Filed', ...over } });
  const pipeRead = (over = {}) => ({ status: 'success', template: { id: 2, name: 'Chapter 7' }, current: { stage_key: 'filed' }, history: [{}, {}], ...over });
  const tplRead = (list = TEMPLATES()) => ({ status: 'success', templates: list });
  const stagesRead = (over = {}) => ({ status: 'success', template: { ...CH13, ...(over.template || {}) }, stages: over.stages || STAGES[3]() });
  function reads(over = {}) {
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect(method).toBe('GET');
      gets.push(p);
      if (p === `/api/cases/${CASE_ID}`) { if (over.gone) throw Object.assign(new Error('Case not found'), { status: 404 }); return over.case || caseRead(); }
      if (p === `/api/cases/${CASE_ID}/pipeline`) return over.pipe || pipeRead();
      if (p === '/api/pipeline-admin/templates') return over.tpls || tplRead();
      if (p === '/api/pipeline-admin/templates/3/stages') return over.stages || stagesRead();
      throw new Error(`unexpected read ${p}`);
    });
    return { b: browser(api), gets };
  }

  test('the request is fixed: POST …/pipeline/move {template_id, stage_id, note}; model junk never reaches it', () => {
    const { b } = reads();
    expect(b.caseTransferRequest({ ...card, template_id: 99, stage: 'docs', case_type: 'X' }))
      .toEqual({ path: `/api/cases/${CASE_ID}/pipeline/move`, method: 'POST', body: { template_id: 3, stage_id: 33, note: 'converted' } });
    expect(b.caseTransferRequest({ ...card, note: null }).body).toEqual({ template_id: 3, stage_id: 33 });
    expect(() => b.caseTransferRequest({ ...card, to: { ...card.to, stage_id: 'x' } })).toThrow('This card has no usable destination.');
    expect(() => b.caseTransferRequest({ ...card, case: { case_id: '../x' } })).toThrow('This card has no usable case id.');
    expect(() => b.caseTransferRequest({ ...card, note: 'x'.repeat(256) })).toThrow(/longer than the stage log keeps/);
  });

  test('the card text names both pipelines, the type / subtype, the passed-over step, both events, the non-atomic writes and the stale-check limit', () => {
    const { b } = reads();
    const text = b.caseTransferText(card);
    for (const line of ['Pipeline transfer proposal — not applied', 'Action: Move to another pipeline', 'From pipeline: Chapter 7', 'From stage: Filed (filed)',
      'To pipeline: Chapter 13 (#3, case)', 'To stage: Filed (filed)', 'Pipeline phase: stays case', 'Type / subtype written: case_subtype "Chapter 7" → "Chapter 13"',
      'Required steps it passes over on Chapter 13: 1 not done or N/A (they will read skipped): "Retainer fee paid" (Retained, skipped, client) — done or N/A: "W-2s received" (Docs requested, na, client); "Credit report pulled" (Docs requested, done, staff)',
      'Required steps left open on Chapter 7: "Credit counseling certificate" (Filed, active, client)',
      'Automation (case.updated — the type / subtype write): no active trigger rule acts (0 checked).',
      'Note: "converted"']) {
      expect(text).toContain(line);
    }
    expect(text).toMatch(/Writes: .* in two steps that are not one transaction\./);
    expect(text).toContain('A step\'s done / not-done status on the destination is not re-read at the click');
  });

  test('a fresh card passes the precheck after exactly the four reads, in order', async () => {
    const { b, gets } = reads();
    await expect(b.caseTransferPrecheck(card)).resolves.toBe('');
    expect(gets).toEqual([`/api/cases/${CASE_ID}`, `/api/cases/${CASE_ID}/pipeline`, '/api/pipeline-admin/templates', '/api/pipeline-admin/templates/3/stages']);
  });

  test.each([
    ['the type changed', { case: caseRead({ case_type: 'Litigation' }) }, /^The type, subtype, phase or stage of case 25-12345-abc changed/],
    ['the subtype changed', { case: caseRead({ case_subtype: 'Chapter 11' }) }, /^The type, subtype, phase or stage/],
    ['the phase changed', { case: caseRead({ pipeline_phase: 'intake' }) }, /^The type, subtype, phase or stage/],
    ['the stored stage changed', { case: caseRead({ case_stage: 'Closed' }) }, /^The type, subtype, phase or stage/],
    ['the case is gone', { gone: true }, /^Case 25-12345-abc no longer exists\. Nothing was written\.$/],
    ['already on the destination', { pipe: pipeRead({ template: { id: 3 }, current: { stage_key: 'filed' } }) }, /^case 25-12345-abc is already on Chapter 13 at Filed \(filed\)\. Nothing was written and no automation ran\.$/],
    ['the resolved pipeline changed', { pipe: pipeRead({ template: { id: 5 } }) }, /^The pipeline or stage of case 25-12345-abc changed/],
    ['the current stage changed', { pipe: pipeRead({ current: { stage_key: 'docs' } }) }, /^The pipeline or stage/],
    ['the history grew (A → B → A)', { pipe: pipeRead({ history: [{}, {}, {}] }) }, /^The pipeline or stage/],
    ['an active template was added (the resolver input)', { tpls: tplRead([...TEMPLATES(), T(8, 'Chapter 13 (new)', 'case', 'Bankruptcy', 'Chapter 13')]) }, /^The active pipelines changed/],
    ['a default flag flipped', { tpls: tplRead(TEMPLATES().map((t) => (t.id === 3 ? { ...t, is_default: 1 } : t))) }, /^The active pipelines changed/],
    ['the destination was deactivated', { stages: stagesRead({ template: { active: 0 } }) }, /^The Chapter 13 pipeline changed or was deactivated/],
    ['the destination\'s subtype was edited', { stages: stagesRead({ template: { case_subtype: 'Ch 13' } }) }, /^The Chapter 13 pipeline changed or was deactivated/],
    ['the stage was deactivated', { stages: stagesRead({ stages: STAGES[3]().map((s) => (s.id === 33 ? { ...s, active: 0 } : s)) }) }, /^The destination stage Filed \(filed\) changed or is no longer active on Chapter 13/],
    ['the stage was renumbered', { stages: stagesRead({ stages: STAGES[3]().map((s) => (s.id === 33 ? { ...s, stage_number: 7 } : s)) }) }, /^The destination stage/],
    ['the stage moved lanes', { stages: stagesRead({ stages: STAGES[3]().map((s) => (s.id === 33 ? { ...s, lane: 'offramp' } : s)) }) }, /^The destination stage/],
    ['a step was added below it', { stages: stagesRead({ stages: STAGES[3]().map((s) => (s.id === 31 ? { ...s, req_count: 3 } : s)) }) }, /^The stages or steps of the Chapter 13 pipeline changed/],
    ['a stage was activated', { stages: stagesRead({ stages: STAGES[3]().map((s) => (s.id === 36 ? { ...s, active: 1 } : s)) }) }, /^The stages or steps/],
  ])('refuses before the claim when %s', async (_why, over, re) => {
    const { b } = reads(over);
    await expect(b.caseTransferPrecheck(card)).resolves.toMatch(re);
  });

  test('a read that fails is not a refusal (the card stays retryable)', async () => {
    const { b } = reads({ tpls: { status: 'success' } });
    await expect(b.caseTransferPrecheck(card)).rejects.toThrow('the pipelines could not be read');
  });

  test('the result check: the case must resolve to the destination at the destination stage', () => {
    const { b } = reads();
    const ok = { status: 'success', noop: false, moved: { template_id: 3, template_name: 'Chapter 13', fields_updated: true }, template: { id: 3, name: 'Chapter 13' }, current: { stage_key: 'filed' } };
    expect(b.caseTransferResult(card, ok)).toEqual({ case_id: CASE_ID });
    // A noop WITH the type / subtype written is a real change (the phantom fix-up) — applied.
    expect(b.caseTransferResult(card, { ...ok, noop: true })).toEqual({ case_id: CASE_ID });
    // A noop with nothing written: a refusal, not "applied".
    let e = (() => { try { b.caseTransferResult(card, { ...ok, noop: true, moved: { ...ok.moved, fields_updated: false } }); } catch (x) { return x; } return null; })();
    expect(e && e.caseTransferNoop).toBe(true);
    // Success that resolves elsewhere: a known FAILURE (something was written).
    e = (() => { try { b.caseTransferResult(card, { ...ok, template: { id: 2, name: 'Chapter 7' } }); } catch (x) { return x; } return null; })();
    expect([e && e.caseTransferOff, e && e.resolved]).toEqual([true, 'Chapter 7']);
    e = (() => { try { b.caseTransferResult(card, { ...ok, current: { stage_key: 'docs' } }); } catch (x) { return x; } return null; })();
    expect(e && e.caseTransferOff).toBe(true);
    expect(() => b.caseTransferResult(card, { status: 'error' })).toThrow('The move route did not confirm the transfer');
  });

  test('THE TORN STATE is a FAILURE naming it — never applied, never "nothing written"; the noop and the lock 409 are refusals; anything else falls through', () => {
    const { b } = reads();
    const torn = b.caseTransferKnownOutcome({ status: 409, message: 'case type/subtype updated for "Chapter 13" but the stage advance failed (Pipeline advance already in progress for case 7KQ2M9XA — retry) — retry the move' });
    expect(torn.status).toBe('Failed — partly written');
    expect(torn.text).toMatch(/^Failed — partly written: the case's type \/ subtype were changed for the "Chapter 13" pipeline, but the stage advance was refused \(Pipeline advance already in progress for case 7KQ2M9XA — retry\)\. The case now resolves to "Chapter 13" while its stage position is still the old one/);
    expect(torn.text).toContain('Do not apply this card again.');
    // Whatever status the advance's error carried — a 400 (stage deactivated) or a 500.
    for (const status of [400, 500]) {
      expect(b.caseTransferKnownOutcome({ status, message: 'case type/subtype updated for "Chapter 13" but the stage advance failed (Stage "Filed" is inactive) — retry the move' }).status).toBe('Failed — partly written');
    }
    expect(b.caseTransferKnownOutcome({ status: 409, message: 'Pipeline advance already in progress for case 7KQ2M9XA — retry' }))
      .toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/another stage change for this case was running at the same moment, and no type \/ subtype was written/) });
    expect(b.caseTransferKnownOutcome(Object.assign(new Error('already there'), { caseTransferNoop: true })).status).toBe('Refused — nothing written');
    expect(b.caseTransferKnownOutcome(Object.assign(new Error('x'), { caseTransferOff: true, resolved: 'Chapter 7' })).text).toMatch(/^Failed — the move route answered success, but the case is not on the destination pipeline .* \(it resolves to "Chapter 7"\)\. Something was written/);
    expect(b.caseTransferKnownOutcome({ status: 400, message: 'Stage "Filed" is inactive' })).toBe(null);
    expect(b.caseTransferKnownOutcome({ status: 409, message: 'case type/subtype updated for "X" but the stage advance failed (y) — retry the move', body: { idempotency: {} } })).toBe(null);
  });
});
