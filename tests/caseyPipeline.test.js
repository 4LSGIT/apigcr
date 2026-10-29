'use strict';
/**
 * tests/caseyPipeline.test.js
 *
 * A9 — Casey advances ONE case to its next pipeline stage or moves it to ONE
 * named stage through reviewed cards: case.pipeline.advance.v1 /
 * case.pipeline.move.v1 → POST /api/cases/:id/pipeline/advance {stage, note?}
 * (the case page's Advance and the board's drag; never the cases PATCH, never
 * /pipeline/move).
 *
 * The contract pinned here (server side; the browser half — the fixed
 * builder, the click-time re-read and requirement recompute, the outcome
 * mapping — is in tests/assistantUi.test.js):
 *   1. the casey_case_pipeline_enabled switch ('0' = dark; unset = on);
 *   2. NO OVERRIDE PATHWAY: any draft key naming an override / bypass is
 *      refused BY NAME before anything is read; a cross-pipeline key too;
 *   3. UNMET REQUIREMENTS: every REQUIRED step not done / N/A that the move
 *      would turn 'skipped' (the resolver's rule 3) refuses the card and is
 *      listed verbatim; optional ones are disclosed; a step back passes none;
 *   4. the destination: advance = the next main-lane stage; move = a stage of
 *      the case's own pipeline named by key or label; the retention crossing
 *      = the chapter pipeline's first stage, only when the subtype names it;
 *   5. phase: the crossing is danger-styled; a case-phase case on the Intake
 *      pipeline is refused; off-ramp / recovery / backward moves warn;
 *   6. downstream automation: the case.stage_advanced envelope advanceStage
 *      will emit, dry-run against the active rules (fires / may run / fails);
 *   7. the card: stages by name, the four overwritten columns, expected =
 *      position + phase/type/subtype + the passed-over requirement signature;
 *   8. the ledger receipt is the STRING case_id; the request detector.
 *
 * The services' real SQL (getPipeline + requirements, the latest-log query,
 * the rule load) and the route's no-requirement-gate / noop behaviour run on
 * a real engine in tests/caseyPipeline.mysql.test.js.
 *
 *   npx jest tests/caseyPipeline.test.js
 */

const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const pipelineService = require(path.join(REPO, 'services', 'pipelineService'));
const pipelineAdmin = require(path.join(REPO, 'services', 'pipelineAdminService'));
const triggerService = require(path.join(REPO, 'services', 'triggerService'));
const { normalizeActionDraft, taskDraftRequested } = svc;

const CASE_ID = '7KQ2M9XA';
const INTAKE = { id: 1, name: 'Intake', role: 'intake', case_type: null, case_subtype: null };
const CH7 = { id: 2, name: 'Chapter 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' };
const stage = (id, key, label, num, over = {}) => ({ stage_id: id, stage_key: key, stage_number: num, internal_label: label,
  client_label: `${label} (client)`, case_stage: 'Open', is_terminal: 0, lane: 'main', default_rec: `Next: ${label}`, client_visible: 1, ...over });
const INTAKE_STAGES = () => [
  stage(11, 'consult_booked', 'Consult booked', 1), stage(12, 'consult_done', 'Consult done', 2),
  stage(13, 'contract_sent', 'Contract sent', 3), stage(18, 'no_show', 'No show', 90, { lane: 'offramp', client_visible: 0 }),
  stage(19, 'dead_lead', 'Dead lead', 91, { lane: 'offramp', client_visible: 0 }),
];
const CH7_STAGES = () => [
  stage(21, 'retained', 'Retained', 1), stage(22, 'docs', 'Docs requested', 2), stage(23, 'filed', 'Filed', 3, { case_stage: 'Filed' }),
  stage(29, 'dismissed', 'Dismissed', 90, { lane: 'offramp', case_stage: 'Closed' }),
];
const req = (key, stageRow, status, over = {}) => ({ requirement_key: key, stage_id: stageRow.stage_id, stage_key: stageRow.stage_key,
  internal_label: `Label of ${key}`, required: 1, owner: 'client', status, override: null, ...over });

// A getPipeline({requirements:true}) payload. `at` = the current stage key
// (null = no history); `reqs` = { stage_key: [requirement rows] }.
function pipeOf({ template = INTAKE, stages, at = null, reqs = {}, projected, history } = {}) {
  const list = (stages || (template.role === 'intake' ? INTAKE_STAGES() : CH7_STAGES()))
    .map((s) => ({ ...s, requirements: (reqs[s.stage_key] || []).map((r) => (typeof r === 'function' ? r(s) : r)) }));
  const matched = at ? list.find((s) => s.stage_key === at) : null;
  const main = list.filter((s) => s.lane !== 'offramp');
  const current = at ? { stage_id: matched ? matched.stage_id : 99, stage_key: at, case_stage: 'Open', status_label: matched ? matched.internal_label : at,
    entered_at: new Date('2026-10-01T12:00:00Z'), entered_by: 6, source: 'manual', note: null } : null;
  const out = { template, current, history: history || (current ? [current] : []), stages: list,
    upcoming: matched ? main.filter((s) => s.stage_number > matched.stage_number) : main };
  if (template.role === 'intake') {
    out.projected = projected !== undefined ? projected : { source: 'subtype', template: { id: CH7.id, name: CH7.name },
      stages: CH7_STAGES().filter((s) => s.lane !== 'offramp').map(({ stage_key, stage_number }) => ({ stage_key, stage_number })) };
  }
  return out;
}

const ADMIN_CH7 = () => CH7_STAGES().map((s) => ({ id: s.stage_id, template_id: CH7.id, stage_key: s.stage_key, stage_number: s.stage_number,
  internal_label: s.internal_label, client_label: s.client_label, client_visible: s.client_visible, lane: s.lane, case_stage: s.case_stage,
  default_rec: s.default_rec, active: 1 }));

let spies = [];
function setup({ caseRow = {}, pipe = pipeOf({ at: 'consult_booked' }), matter = CH7, adminStages = ADMIN_CH7(), adminReqs = [],
  rules = [], latest = { template_id: 1, stage_key: 'consult_booked' }, caseMissing = false } = {}) {
  const row = { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy', case_subtype: 'Chapter 7',
    pipeline_phase: 'intake', case_stage: 'Open', case_status: 'Consult booked', case_rec: 'Call the client back', ...caseRow };
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id, include) => {
      expect(include).toBe('contacts');
      if (caseMissing || String(id).toLowerCase() !== CASE_ID.toLowerCase()) return null;
      return { case: { ...row }, clients: [{ contact_name: 'Dana Debtor', relate_type: 'Primary', contact_ssn: '123-45-6789' }, { contact_name: 'Opp Counsel', relate_type: 'Other' }] };
    }),
    jest.spyOn(pipelineService, 'getPipeline').mockImplementation(async (_db, id, opts) => {
      expect([id, opts]).toEqual([CASE_ID, { requirements: true }]);
      return JSON.parse(JSON.stringify(pipe));
    }),
    jest.spyOn(pipelineService, 'resolveMatterTemplate').mockImplementation(async () => matter),
    jest.spyOn(pipelineAdmin, 'listStages').mockImplementation(async (_db, tid) => ({ template: matter, stages: tid === CH7.id ? adminStages : [] })),
    jest.spyOn(pipelineAdmin, 'listRequirements').mockImplementation(async () => ({ stage: {}, requirements: adminReqs })),
    jest.spyOn(triggerService, 'listActiveRulesForEvent').mockImplementation(async (_db, ev) => { expect(ev).toBe('case.stage_advanced'); return rules; }),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === 'SELECT template_id, stage_key FROM case_stage_log WHERE case_id = ? ORDER BY entered_at DESC, id DESC LIMIT 1') {
      expect(params).toEqual([CASE_ID]);
      return [latest ? [latest] : []];
    }
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CASE_PIPELINE_ENABLED; });

const EVIDENCE = [{ id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }, { case_id: 'OTHER123' }] }];
const advance = (over = {}) => ({ kind: 'case.pipeline.advance.v1', case_id: CASE_ID, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const move = (stageName, over = {}) => ({ kind: 'case.pipeline.move.v1', case_id: CASE_ID, stage: stageName, evidence: [{ query_id: 'q1', row_number: 1 }], ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);

describe('the per-family switch', () => {
  test("'0' makes both kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CASE_PIPELINE_ENABLED = '0';
    for (const v of [advance(), move('Consult done')]) await expect(run(v)).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_CASE_PIPELINE_ENABLED;
    for (const v of [advance(), move('Consult done')]) await expect(run(v)).resolves.toMatchObject({ kind: v.kind, status: 'draft' });
  });
});

describe('NO OVERRIDE PATHWAY — an override key is refused by name before anything is read', () => {
  test.each([
    ['override'], ['overrides'], ['requirement_overrides'], ['override_requirements'], ['skip_requirements'], ['ignore_requirements'],
    ['force'], ['bypass'], ['waive'], ['mark_done'], ['mark_na'], ['not_applicable'], ['requirements'], ['unblock'], ['exempt'],
  ])('%s', async (key) => {
    const db = setup();
    await expect(normalizeActionDraft(db, advance({ [key]: true }), EVIDENCE, { currentUserId: 6 }))
      .rejects.toThrow(new RegExp(`^REQUIREMENT OVERRIDE refused \\(${key}\\): a pipeline card never marks a requirement done or N/A, never skips one and never moves a case past an unmet one — Casey has no override pathway`));
    await expect(normalizeActionDraft(db, move('Filed', { [key]: ['docs_received'] }), EVIDENCE, { currentUserId: 6 }))
      .rejects.toThrow(/^REQUIREMENT OVERRIDE refused/);
    expect(caseService.getCase).not.toHaveBeenCalled();
    expect(pipelineService.getPipeline).not.toHaveBeenCalled();
  });

  test('another pipeline (POST /pipeline/move territory) is refused by name too', async () => {
    for (const key of ['template_id', 'pipeline', 'case_subtype']) {
      await refuse(move('Retained', { [key]: 2 }), new RegExp(`^Moving a case onto ANOTHER pipeline \\(${key}\\) is not available to Casey`));
    }
  });

  test('unknown keys are refused, naming what each kind takes', async () => {
    await refuse(advance({ stage: 'docs' }), /^A pipeline advance carries unsupported fields: stage — it takes case_id, note, evidence only \(the destination is the case's next stage; to name one, propose case.pipeline.move.v1\)/);
    await refuse(move('docs', { stage_id: 22 }), /^A pipeline move carries unsupported fields: stage_id — it takes case_id, stage, note, evidence only \(name the destination in "stage"/);
    await refuse(move('docs', { source: 'system' }), /unsupported fields: source/);
  });
});

describe('evidence, case id, note, stage name', () => {
  test('evidence must cite a row carrying the exact case_id', async () => {
    await refuse(advance({ evidence: [{ query_id: 'q1', row_number: 2 }] }), /^The pipeline advance evidence does not identify case 7KQ2M9XA — cite a row carrying its exact case_id/);
    await refuse(advance({ case_id: 'bad id' }), /needs the case's exact case_id/);
    await refuse(advance(), /^Case 7KQ2M9XA no longer exists$/, { caseMissing: true });
  });
  test('the note is text up to 255 characters (the stage log width); blank is no note', async () => {
    await refuse(advance({ note: 'x'.repeat(256) }), /^The pipeline note is 256 characters — the stage log keeps 255$/);
    await refuse(advance({ note: 5 }), /^The pipeline note must be text$/);
    await expect(run(advance({ note: '  ' }))).resolves.toMatchObject({ note: null });
    await expect(run(advance({ note: 'x'.repeat(255) }))).resolves.toMatchObject({ note: 'x'.repeat(255) });
  });
  test('a move needs a stage name', async () => {
    await refuse(move(''), /^A pipeline move needs "stage"/);
    await refuse(move(7), /^A pipeline move needs "stage"/);
  });
});

describe('the destination', () => {
  test('advance = the next MAIN-lane stage; the card names both stages and the pipeline', async () => {
    const card = await run(advance({ note: 'consult held' }));
    expect(card).toMatchObject({
      kind: 'case.pipeline.advance.v1', status: 'draft', crossing: false, note: 'consult held',
      case: { case_id: CASE_ID, case_number: '25-12345-abc', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', clients: ['Dana Debtor'] },
      pipeline: { template_id: 1, name: 'Intake', role: 'intake' },
      from: { stage_key: 'consult_booked', stage_id: 11, label: 'Consult booked', lane: 'main', on_pipeline: true },
      to: { template_id: 1, template_name: 'Intake', template_role: 'intake', stage_id: 12, stage_key: 'consult_done', stage_number: 2,
        internal_label: 'Consult done', client_label: 'Consult done (client)', client_visible: 1, lane: 'main' },
      writes: { case_stage: { from: 'Open', to: 'Open' }, case_status: { from: 'Consult booked', to: 'Consult done' },
        case_rec: { from: 'Call the client back', to: 'Next: Consult done' }, pipeline_phase: { from: 'intake', to: 'intake' } },
      warnings: [],
      expected: { template_id: 1, stage_key: 'consult_booked', history_count: 1, pipeline_phase: 'intake', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', requirements: [] },
    });
    // Names only: the SSN getCase's SELECT co.* carries never reaches the card.
    expect(JSON.stringify(card)).not.toContain('123-45-6789');
    expect(card.effects).toContain('Stage log: one new entry, entered by you, with the note "consult held"; stage-age reminders restart from this entry.');
    expect(card.effects).toContain('Next step (case_rec) is REPLACED: "Call the client back" → "Next: Consult done" — the stage\'s default; any hand-written next step is lost.');
    expect(card.effects).toContain('Client portal: the client\'s timeline shows "Consult done (client)" as the case\'s current stage.');
  });

  test('advance with no history goes to the first main stage; from an off-ramp or the last stage it refuses', async () => {
    await expect(run(advance(), { pipe: pipeOf({ at: null }) })).resolves.toMatchObject({ from: null, to: { stage_key: 'consult_booked' }, expected: { stage_key: null, history_count: 0 } });
    await refuse(advance(), /^Case 25-12345-abc is on the off-ramp No show \(no_show\), which has no natural next stage. Name the stage it should go to — propose case.pipeline.move.v1$/, { pipe: pipeOf({ at: 'no_show' }) });
    await refuse(advance(), /^Case 25-12345-abc is at the last stage of the Chapter 7 pipeline \(Filed \(filed\)\) — there is no next stage/,
      { caseRow: { pipeline_phase: 'case' }, pipe: pipeOf({ template: CH7, at: 'filed' }) });
  });

  test('move resolves a stage of the case\'s own pipeline by key or label (any case), both lanes', async () => {
    await expect(run(move('DEAD_LEAD'))).resolves.toMatchObject({ to: { stage_key: 'dead_lead', lane: 'offramp' } });
    await expect(run(move('contract sent'))).resolves.toMatchObject({ to: { stage_key: 'contract_sent' } });
    await refuse(move('Consult booked'), /^Case 25-12345-abc is already at Consult booked \(consult_booked\) — that changes nothing$/);
    await refuse(move('Filed'), /^"Filed" is not a stage of case 25-12345-abc's Intake pipeline \(its stages are: Consult booked \(consult_booked\), Consult done \(consult_done\), Contract sent \(contract_sent\), No show \(no_show\), Dead lead \(dead_lead\)\)\. The one other destination Casey can offer is its chapter pipeline's FIRST stage, Retained \(retained\) on Chapter 7/);
    await refuse(move('Archived'), /^"Archived" is not a stage of case 25-12345-abc's Chapter 7 pipeline — its stages are: Retained \(retained\), Docs requested \(docs\), Filed \(filed\), Dismissed \(dismissed\)$/,
      { caseRow: { pipeline_phase: 'case' }, pipe: pipeOf({ template: CH7, at: 'docs' }) });
    const twins = INTAKE_STAGES().map((s) => (s.stage_key === 'no_show' ? { ...s, internal_label: 'Consult done' } : s));
    await refuse(move('Consult done'), /^"Consult done" names 2 stages of the Intake pipeline: Consult done \(consult_done\), Consult done \(no_show\) — name it by its key$/, { pipe: pipeOf({ stages: twins, at: 'consult_booked' }) });
    // A KEY wins over a label naming another stage.
    await expect(run(move('no_show'), { pipe: pipeOf({ stages: twins, at: 'consult_booked' }) })).resolves.toMatchObject({ to: { stage_id: 18 } });
  });

  test('a key of digits only is refused (the route would read it as a stage id)', async () => {
    const stages = INTAKE_STAGES().map((s) => (s.stage_key === 'consult_done' ? { ...s, stage_key: '22' } : s));
    await refuse(advance(), /has a key of digits only, which the advance route reads as a stage id/, { pipe: pipeOf({ stages, at: 'consult_booked' }) });
  });

  test('a retained (phase case) case that only resolves to Intake is refused — moving it there would put it back into intake', async () => {
    await refuse(advance(), /^Case 25-12345-abc is retained \(pipeline phase "case"\) but no chapter pipeline matches its type\/subtype \(Litigation \/ no subtype\), so it shows the Intake pipeline\. Moving it there would put a retained case back into intake/,
      { caseRow: { pipeline_phase: 'case', case_type: 'Litigation', case_subtype: '' } });
    // ' Case ' with stray spacing/case still reads as the case phase.
    await refuse(move('Dead lead'), /is retained \(pipeline phase "case"\)/, { caseRow: { pipeline_phase: ' Case ' } });
  });
});

describe('THE RETENTION CROSSING — intake → the chapter pipeline\'s first stage, danger-styled', () => {
  const atEnd = () => pipeOf({ at: 'contract_sent' });
  test('advance from the last intake stage enters the chapter pipeline at its first stage', async () => {
    const card = await run(advance(), { pipe: atEnd(), adminReqs: [{ requirement_key: 'fee', internal_label: 'Retainer fee paid', required: 1, active: 1 }, { requirement_key: 'old', internal_label: 'Retired', required: 1, active: 0 }] });
    expect(card).toMatchObject({
      crossing: true, to: { template_id: 2, template_name: 'Chapter 7', template_role: 'case', stage_id: 21, stage_key: 'retained', stage_number: 1 },
      writes: { pipeline_phase: { from: 'intake', to: 'case' } },
      requirements: { destination: [{ internal_label: 'Retainer fee paid', required: 1, status: null }] },
      expected: { template_id: 1, stage_key: 'contract_sent' },
    });
    expect(card.warnings[0]).toMatch(/^LIFECYCLE — THIS RETAINS THE CASE: pipeline phase intake → case\. The case leaves the Intake pipeline for Chapter 7/);
  });

  test('move to the first stage by name crosses from anywhere in intake; a later chapter stage is refused', async () => {
    await expect(run(move('retained'))).resolves.toMatchObject({ crossing: true, to: { stage_key: 'retained' } });
    await expect(run(move('Retained'))).resolves.toMatchObject({ crossing: true });
    await refuse(move('Docs requested'), /The one other destination Casey can offer is its chapter pipeline's FIRST stage, Retained \(retained\) on Chapter 7: the requirements of any later stage cannot be checked before the case is on that pipeline$/);
  });

  test.each([
    ['no chapter pipeline', { matter: null }, /no chapter pipeline matches its type\/subtype \(Bankruptcy \/ Chapter 7\)/],
    ['the subtype does not name it (generic projection — the type-default footgun)', { pipe: pipeOf({ at: 'contract_sent', projected: { source: 'generic', template: null, stages: [] } }) },
      /its subtype \(Chapter 7\) does not name the Chapter 7 pipeline exactly — entering it would rest on the case type's default pipeline/],
    ['the projection names ANOTHER pipeline', { pipe: pipeOf({ at: 'contract_sent', projected: { source: 'subtype', template: { id: 3, name: 'Chapter 13' }, stages: [{ stage_key: 'retained' }] } }) },
      /does not name the Chapter 7 pipeline exactly/],
    ['its first stage is an off-ramp', { adminStages: ADMIN_CH7().map((s) => (s.stage_key === 'retained' ? { ...s, stage_number: 95, lane: 'offramp' } : s)).map((s) => (s.stage_key === 'dismissed' ? { ...s, stage_number: 0 } : s)) },
      /first stage \(Dismissed \(dismissed\)\) is an off-ramp/],
    ['its first key is active on the current pipeline', { pipe: pipeOf({ stages: [...INTAKE_STAGES().slice(0, 3), stage(17, 'retained', 'Retained (intake)', 4)], at: 'retained' }) },
      /but its first stage key "retained" is also active on the case's current pipeline, so the route would resolve it there$/],
    ['it has no active stage', { adminStages: ADMIN_CH7().map((s) => ({ ...s, active: 0 })) }, /the Chapter 7 pipeline has no active stages/],
    ['the projection disagrees with the stage list', { adminStages: ADMIN_CH7().map((s) => (s.stage_key === 'retained' ? { ...s, stage_key: 'onboarded' } : s)) },
      /the Chapter 7 pipeline's stages changed while Casey read them/],
  ])('refused when %s', async (_name, opts, re) => {
    await refuse(advance(), re, { pipe: atEnd(), ...opts });
  });

  test('the crossing passes EVERY intake step: a required one still open refuses, verbatim', async () => {
    const pipe = pipeOf({ at: 'contract_sent', reqs: {
      consult_booked: [(s) => req('questionnaire', s, 'skipped', { internal_label: 'Intake questionnaire submitted' })],
      contract_sent: [(s) => req('contract_signed', s, 'active', { internal_label: 'Retainer contract signed', owner: 'client' }), (s) => req('id_copy', s, 'done')],
    } });
    await refuse(advance(), /^UNMET REQUIREMENTS: moving case 25-12345-abc from Contract sent \(contract_sent\) to Retained \(retained\) on Chapter 7 would pass over 1 required step that is not done: "Retainer contract signed" \(stage Contract sent, active, client\)\. Casey never moves a case past an unmet requirement and cannot override one/, { pipe });
    // 'skipped' was passed over before this card: not this move's blocker.
    const ok = pipeOf({ at: 'contract_sent', reqs: { consult_booked: [(s) => req('questionnaire', s, 'skipped')] } });
    await expect(run(advance(), { pipe: ok })).resolves.toMatchObject({ crossing: true, expected: { requirements: ['questionnaire@11:skipped:1'] } });
  });
});

describe('UNMET REQUIREMENTS — the normalizer is the gate the route does not have (fail closed, verbatim, no override)', () => {
  test('advance: the current stage\'s required step still open refuses, naming every one', async () => {
    const pipe = pipeOf({ at: 'consult_booked', reqs: { consult_booked: [
      (s) => req('questionnaire', s, 'active', { internal_label: 'Intake questionnaire submitted' }),
      (s) => req('paystubs', s, 'active', { internal_label: 'Six months of pay stubs', owner: 'staff' }),
      (s) => req('optional_call', s, 'active', { required: 0 }),
      (s) => req('id_copy', s, 'na'),
    ] } });
    await refuse(advance(), /^UNMET REQUIREMENTS: moving case 25-12345-abc from Consult booked \(consult_booked\) to Consult done \(consult_done\) would pass over 2 required steps that are not done: "Intake questionnaire submitted" \(stage Consult booked, active, client\); "Six months of pay stubs" \(stage Consult booked, active, staff\)\. Casey never moves a case past an unmet requirement and cannot override one\. Complete them, or the user marks them done \/ N\/A on the case's Steps panel, then ask again$/, { pipe });
  });

  test('a skip ahead passes the upcoming steps of every stage in between; an off-ramp passes everything numbered below it', async () => {
    const pipe = pipeOf({ at: 'consult_booked', reqs: { consult_done: [(s) => req('fee_quote', s, 'upcoming', { internal_label: 'Fee quoted' })] } });
    await refuse(move('contract_sent'), /would pass over 1 required step that is not done: "Fee quoted" \(stage Consult done, upcoming, client\)/, { pipe });
    await refuse(move('Dead lead'), /to Dead lead \(dead_lead\) would pass over 1 required step that is not done: "Fee quoted"/, { pipe });
    // The destination's own steps are not passed over: they become its work list.
    await expect(run(advance(), { pipe })).resolves.toMatchObject({ to: { stage_key: 'consult_done' },
      requirements: { destination: [{ internal_label: 'Fee quoted', required: 1, status: 'upcoming' }] } });
  });

  test('a step BACK passes nothing open (the current stage\'s steps read upcoming again) — allowed, with the BACKWARD warning', async () => {
    const pipe = pipeOf({ template: CH7, at: 'filed', reqs: { filed: [(s) => req('341_held', s, 'active')], retained: [(s) => req('fee', s, 'done')] } });
    const card = await run(move('docs'), { caseRow: { pipeline_phase: 'case' }, pipe });
    expect(card.warnings).toEqual(['BACKWARD: the case moves back from Filed (filed) to Docs requested (docs); the steps of the stages in between read as upcoming again.']);
    expect(card.requirements.satisfied).toEqual([{ internal_label: 'Label of fee', stage_label: 'Retained', status: 'done' }]);
    expect(card.expected.requirements).toEqual(['fee@21:done:1']);
  });

  test('optional steps left open are disclosed (they will read skipped); done / N/A are listed as satisfied', async () => {
    const pipe = pipeOf({ at: 'consult_booked', reqs: { consult_booked: [(s) => req('optional_call', s, 'active', { required: 0, internal_label: 'Courtesy call' }), (s) => req('id_copy', s, 'na', { internal_label: 'Photo ID' })] } });
    const card = await run(advance(), { pipe });
    expect(card.requirements).toEqual({
      satisfied: [{ internal_label: 'Photo ID', stage_label: 'Consult booked', status: 'na' }],
      optional_skipped: [{ internal_label: 'Courtesy call', stage_label: 'Consult booked', status: 'active' }],
      destination: [],
    });
    expect(card.expected.requirements).toEqual(['id_copy@11:na:1', 'optional_call@11:active:0']);
  });

  test('required is the resolver\'s 1/0 and an unknown status reads as not satisfied ONLY when active/upcoming', async () => {
    const pipe = pipeOf({ at: 'consult_booked', reqs: { consult_booked: [(s) => req('a', s, 'active', { required: true })] } });
    await refuse(advance(), /UNMET REQUIREMENTS/, { pipe });
  });
});

describe('lane and direction warnings', () => {
  test('off-ramp and recovery are danger lines; a forward main move is not', async () => {
    await expect(run(move('Dead lead'))).resolves.toMatchObject({ warnings: ['OFF-RAMP: Dead lead (dead_lead) takes the case off the Intake pipeline\'s main path.'] });
    await expect(run(move('Consult done'), { pipe: pipeOf({ at: 'no_show' }) })).resolves.toMatchObject({ warnings: ['RECOVERY: the case comes back from the off-ramp No show (no_show) onto the main path.'] });
    const skip = await run(move('Contract sent'));
    expect(skip.warnings).toEqual([]);
    expect(skip.effects[0]).toBe('Skips 1 stage: Consult done (consult_done) — skipping is legal; the log records only the destination.');
  });
  test('a staff-only stage and an unchanged next step are said plainly', async () => {
    const card = await run(move('Dead lead'), { caseRow: { case_rec: 'Next: Dead lead' } });
    expect(card.effects).toContain('Client portal: this stage is staff-only — the client\'s timeline does not show it.');
    expect(card.effects.some((e) => /case_rec/.test(e))).toBe(false);
  });
});

describe('downstream automation — the exact case.stage_advanced envelope, dry-run against every active rule', () => {
  const rule = (id, name, match, actions, over = {}) => ({ id, name, event_type: 'case.stage_advanced', match_mode: 'conditions', match_config: match,
    transform_mode: 'passthrough', transform_config: null, min_interval_s: 0, cooling_down: 0, actions, ...over });
  const RULES = () => [
    rule(12, 'Stage change → case log', { operator: 'and', conditions: [] }, [{ id: 1, name: 'Log it', action_type: 'internal_function', config: { function_name: 'create_log' } }]),
    rule(14, 'Consult done → welcome', { operator: 'and', conditions: [{ path: 'data.stage_key', op: 'equals', value: 'consult_done' }] },
      [{ id: 2, name: null, action_type: 'workflow', config: { workflow_id: 42 } }, { id: 3, name: 'Drip', action_type: 'sequence', config: { template_id: 7 } },
        { id: 4, name: '', action_type: 'hook', config: { slug: 'zap' } }, { id: 5, name: '', action_type: 'http', config: '{"url":"https://example.com/x"}' }]),
    rule(15, 'Only filed', { operator: 'and', conditions: [{ path: 'data.stage_key', op: 'equals', value: 'filed' }] }, [{ id: 6, action_type: 'workflow', config: { workflow_id: 9 } }]),
    rule(16, 'From consult_booked, with note', { operator: 'and', conditions: [{ path: 'extra.from_stage', op: 'equals', value: 'consult_booked' }, { path: 'extra.note', op: 'equals', value: 'go' }] },
      [{ id: 7, action_type: 'internal_function', config: { function_name: 'set_var' } }], { cooling_down: 1, min_interval_s: 300 }),
  ];
  test('rules that would run are listed with their actions; non-matching ones are counted', async () => {
    const card = await run(advance({ note: 'go' }), { rules: RULES() });
    expect(card.automation).toEqual({ rules_checked: 4, quiet: 1, lines: [
      'Trigger rule #12 "Stage change → case log" runs: calls create_log ("Log it")',
      'Trigger rule #14 "Consult done → welcome" runs: starts workflow #42; enrolls in sequence template #7 ("Drip"); runs hook "zap"; calls example.com over HTTP',
      'Trigger rule #16 "From consult_booked, with note" matches but is cooling down (it ran within its 300s minimum interval) — it is skipped if applied now, otherwise it runs: calls set_var',
    ] });
    expect(card.warnings).toEqual([]);
  });

  test('the envelope is advanceStage\'s own: data from the destination, extra.from_* from the LATEST log row, the note, the actor', async () => {
    const seen = [];
    const db = setup({ rules: [rule(1, 'r', { operator: 'and', conditions: [] }, [])], latest: { template_id: 1, stage_key: 'consult_booked' } });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (_r, env) => { seen.push(env); return { matched: false }; }));
    await normalizeActionDraft(db, advance({ note: 'held' }), EVIDENCE, { currentUserId: 6 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ event: 'case.stage_advanced', case_id: CASE_ID, source: 'manual', actor: { user_id: 6 },
      data: { stage_key: 'consult_done', stage_id: 12, template_id: 1, case_stage: 'Open', status_label: 'Consult done', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
      extra: { from_stage: 'consult_booked', from_template_id: 1, note: 'held' } });
    // No history: the from fields are null, as advanceStage emits them.
    seen.length = 0;
    const db2 = setup({ rules: [rule(1, 'r', { operator: 'and', conditions: [] }, [])], latest: null, pipe: pipeOf({ at: null }) });
    await normalizeActionDraft(db2, advance(), EVIDENCE, { currentUserId: null });
    expect(seen[0]).toMatchObject({ actor: { user_id: 0 }, data: { stage_key: 'consult_booked' }, extra: { from_stage: null, from_template_id: null, note: null } });
  });

  test('a rule that cannot be evaluated MAY run (danger); a failing transform is said; a throwing evaluation is not a match', async () => {
    const db = setup({ rules: [
      rule(20, 'Code match', { code: 'return true' }, [{ id: 8, action_type: 'workflow', config: { workflow_id: 5 } }], { match_mode: 'code' }),
      rule(21, 'Bad transform', { operator: 'and', conditions: [] }, [{ id: 9, action_type: 'workflow', config: { workflow_id: 6 } }]),
      rule(22, 'Throws', { operator: 'and', conditions: [] }, []),
    ] });
    spies.push(jest.spyOn(triggerService, 'evaluateDraft').mockImplementation(async (r) => {
      if (r.id === 20) return { matched: false, match_error: 'match code threw: GUEST_CODE_BUSY' };
      if (r.id === 21) return { matched: true, transform_ok: false, transform_error: 'mapper broke' };
      throw new Error('engine down');
    }));
    const card = await normalizeActionDraft(db, advance(), EVIDENCE, { currentUserId: 6 });
    expect(card.automation.lines).toEqual([
      'Trigger rule #20 "Code match" could not be evaluated for this move (match code threw: GUEST_CODE_BUSY) — it MAY run: starts workflow #5',
      'Trigger rule #21 "Bad transform" matches, but its transform fails on this event (mapper broke) — its actions would not run and the rule records a failure',
      'Trigger rule #22 "Throws" could not be evaluated for this move (engine down) — it MAY run: no active actions',
    ]);
    expect(card.warnings).toEqual(['AUTOMATION: at least one trigger rule could not be evaluated for this move — read its line; it may run.']);
  });
});

describe('the ledger, the request detector', () => {
  test('both kinds receipt the STRING case_id', () => {
    expect(ledger.KINDS.get('case.pipeline.advance.v1')).toBe('case_id');
    expect(ledger.KINDS.get('case.pipeline.move.v1')).toBe('case_id');
    expect(ledger.STRING_RECEIPT_FIELDS.has('case_id')).toBe(true);
  });

  test.each([
    ['advance the Smith case to the next stage', true],
    ['move this case to the Filed stage', true],
    ['put the lead on dead lead', true],
    ['mark it as retained', true],
    ['push the file to the next stage please', true],
    ['what stage is the Smith case at?', false],
    ['how many cases are in the filed stage?', false],
  ])('%s → %s', (q, want) => {
    expect(taskDraftRequested(q)).toBe(want);
  });
});
