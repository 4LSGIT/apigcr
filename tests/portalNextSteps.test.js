// tests/portalNextSteps.test.js
//
// R3 — the portal's "Your next steps" card
// (services/portalCaseService.buildNextSteps, driven for real; getCaseView
// wiring at the foot).
//
// WHY THIS FILE EXISTS
//
// The card is the only surface that tells a client what THEY still have to do,
// and every one of its rules is a decision that reads as arbitrary until it is
// pinned:
//
//   · THE SINGLE ACTIVE-NOW RULE (frozen). Exactly one or zero steps ever
//     carry the chip, and the pick is the FIRST step that is simultaneously
//     status='active' + required=1 + owner='client'. Each condition is
//     separately load-bearing, so each gets its own row in the matrix below —
//     in particular a STAFF-owned step whose status is 'active' must render
//     and must NEVER chip, which is the failure that would tell a client to go
//     do the thing their attorney is doing.
//   · SKIPPED / NA ARE HIDDEN. Both are true statements the client has no use
//     for; leaking either invites "why does it say I skipped something?".
//   · EVENT-KIND STEPS TAKE NO NUMBER. They are not something the client does,
//     so they carry a calendar glyph — and must not consume a number, or the
//     chips read 1, 3, 4 and look like a step went missing.
//   · CLIENT VOCABULARY OR SILENCE. A client_visible requirement with no
//     client_label is a config hole; falling back to internal_label would put
//     staff vocabulary in front of a client, which is the portal's oldest
//     hard invariant.
//   · FEATURE-DETECTED PROJECTION. R2.5's `projected` ships in a parallel
//     slice; the card must render identically with it, without it, and against
//     a server that has never heard of it.
//
// Fixture shapes are copied from the REAL contracts: resolvedRequirement from
// services/requirementService's header, the pipeline payload from
// getPipeline's docblock.
//
// Run:
//   npx jest tests/portalNextSteps.test.js

'use strict';

jest.mock('../services/pipelineService', () => ({ getPipeline: jest.fn() }));
jest.mock('../lib/portalCardEngine', () => ({ renderCards: jest.fn() }));
jest.mock('../services/requirementService', () => ({ resolveRequirements: jest.fn() }));

const pipelineService = require('../services/pipelineService');
const portalCardEngine = require('../lib/portalCardEngine');
const requirementService = require('../services/requirementService');
const svc = require('../services/portalCaseService');

const build = svc._buildNextSteps;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** getPipeline's `stages` projection. */
function stage(key, number, over = {}) {
  return Object.assign({
    stage_id: 100 + number,
    stage_key: key,
    stage_number: number,
    internal_label: 'INTERNAL ' + key,      // must never surface
    client_label: 'Client ' + key,
    case_stage: 'Pending',
    is_terminal: 0,
    lane: 'main',
    default_rec: '',
    client_visible: 1,
  }, over);
}

const S_DOCS   = stage('docs', 2);           // stage_id 102 — the current one
const S_FILED  = stage('filed', 3);          // stage_id 103
const S_341    = stage('meeting_341', 4);    // stage_id 104
const S_DEAD   = stage('dismissed', 9, { lane: 'offramp', client_visible: 0 });
const S_PAST   = stage('retained', 1);       // stage_id 101 — already left

const STAGES = [S_PAST, S_DOCS, S_FILED, S_341, S_DEAD];

/** resolvedRequirement — requirementService's frozen output shape. */
function req(over = {}) {
  return Object.assign({
    requirement_key: 'upload_docs',
    stage_id: 102,
    stage_key: 'docs',
    internal_label: 'INTERNAL upload docs',   // must never surface
    client_label: 'Upload your documents',
    client_visible: 1,
    required: 1,
    owner: 'client',
    kind: 'task',
    hint: null,
    effort: null,
    group_label: 'Documents',
    sort_order: 1,
    status: 'active',
    satisfied_at: null,
    detail: null,
    progress: null,
    override: null,
  }, over);
}

function pipeline(over = {}) {
  return Object.assign({
    template: { id: 2, name: 'BK Ch 7', role: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7' },
    current: { stage_id: 102, stage_key: 'docs', case_stage: 'Pending',
               status_label: 'SNAPSHOT docs', entered_at: new Date('2026-06-10T16:00:00Z'),
               entered_by: 5, source: 'manual', note: 'internal note' },
    history: [],
    upcoming: [S_FILED, S_341],
    stages: STAGES,
  }, over);
}

const labels = (ns) => ns.steps.map(s => s.label);
const chips = (ns) => ns.steps.filter(s => s.active_now).length;

// ─────────────────────────────────────────────────────────────────────────────
// The set
// ─────────────────────────────────────────────────────────────────────────────

describe('the step set', () => {
  test('CURRENT + UPCOMING main-lane stages, ordered stage → sort_order', async () => {
    const ns = build(pipeline(), [
      // Deliberately shuffled relative to render order — the bucketing walks
      // the STAGE order and preserves the resolver's within-stage order.
      req({ requirement_key: 'a341', stage_id: 104, client_label: 'Attend your 341', status: 'upcoming' }),
      req({ requirement_key: 'docs2', stage_id: 102, client_label: 'Second doc task', sort_order: 2, status: 'active' }),
      req({ requirement_key: 'docs1', stage_id: 102, client_label: 'First doc task', sort_order: 1, status: 'active' }),
      req({ requirement_key: 'filed', stage_id: 103, client_label: 'Filing step', status: 'upcoming' }),
    ]);
    // Current stage (102) first, then upcoming in the payload's order.
    expect(labels(ns)).toEqual(
      ['Second doc task', 'First doc task', 'Filing step', 'Attend your 341']);
  });

  test('requirements of stages the case has ALREADY LEFT are absent — the card is not a changelog', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'old', stage_id: 101, client_label: 'Sign your retainer', status: 'done',
            satisfied_at: new Date('2026-05-01T16:00:00Z') }),
      req({ client_label: 'Upload your documents' }),
    ]);
    expect(labels(ns)).toEqual(['Upload your documents']);
  });

  test('off-ramp stages never contribute steps — not as current, not from `stages`', async () => {
    // The case is sitting ON an off-ramp. "Your next steps" is a statement
    // about the happy path; Dismissed has no next step to offer.
    const ns = build(
      pipeline({ current: { stage_key: 'dismissed' }, upcoming: [] }),
      [req({ requirement_key: 'x', stage_id: S_DEAD.stage_id, client_label: 'Off-ramp work' })]
    );
    expect(ns).toBeNull();
  });

  test('a stage with no `lane` is MAIN (pre-migration payload) — the isMainLane default', async () => {
    const noLane = stage('docs', 2, { lane: undefined });
    const ns = build(
      pipeline({ stages: [noLane], upcoming: [], current: { stage_key: 'docs' } }),
      [req()]
    );
    expect(labels(ns)).toEqual(['Upload your documents']);
  });

  test('no history at all → upcoming-only card (day-one case)', async () => {
    const ns = build(
      pipeline({ current: null, upcoming: [S_DOCS, S_FILED] }),
      [req({ status: 'upcoming' }),
       req({ requirement_key: 'f', stage_id: 103, client_label: 'Filing step', status: 'upcoming' })]
    );
    expect(labels(ns)).toEqual(['Upload your documents', 'Filing step']);
    expect(chips(ns)).toBe(0);     // nothing is active yet
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hidden statuses
// ─────────────────────────────────────────────────────────────────────────────

describe('skipped / na are hidden (v1, frozen)', () => {
  test('neither renders, and neither leaks into the serialized payload', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'skip', client_label: 'Skipped work', sort_order: 1, status: 'skipped' }),
      req({ requirement_key: 'na',   client_label: 'Not applicable work', sort_order: 2, status: 'na',
            override: { status: 'na', note: 'staff said no', set_by: 5, at: new Date() } }),
      req({ requirement_key: 'live', client_label: 'Upload your documents', sort_order: 3 }),
    ]);
    expect(labels(ns)).toEqual(['Upload your documents']);
    expect(JSON.stringify(ns)).not.toMatch(/Skipped work|Not applicable work|staff said no/);
  });

  test('a card whose every step is hidden is NULL, not an empty shell', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', status: 'skipped' }),
      req({ requirement_key: 'b', status: 'na' }),
    ]);
    expect(ns).toBeNull();
  });

  test('hidden steps do not count toward the header', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'A', sort_order: 1, status: 'skipped' }),
      req({ requirement_key: 'b', client_label: 'B', sort_order: 2, status: 'active' }),
    ]);
    expect(ns.remaining).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The single Active-now rule (frozen)
// ─────────────────────────────────────────────────────────────────────────────

describe('the single Active-now rule', () => {
  test('FIRST client-owned required active step wins — and only it', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'one', client_label: 'First active', sort_order: 1, status: 'active' }),
      req({ requirement_key: 'two', client_label: 'Second active', sort_order: 2, status: 'active' }),
    ]);
    expect(chips(ns)).toBe(1);
    expect(ns.steps.find(s => s.active_now).label).toBe('First active');
  });

  test('a STAFF-owned active step RENDERS but never chips', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'staffwork', client_label: 'We are preparing your petition',
            owner: 'staff', status: 'active', hint: 'Your attorney is drafting this' }),
    ]);
    expect(labels(ns)).toEqual(['We are preparing your petition']);
    expect(chips(ns)).toBe(0);
    // The hint is what tells the client why there is nothing to press.
    expect(ns.steps[0].subtitle).toBe('Your attorney is drafting this');
  });

  test('a SYSTEM-owned active step likewise renders and never chips', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'm341', client_label: '341 meeting scheduled', owner: 'system',
            kind: 'event', status: 'active', hint: 'Set by the court after filing' }),
    ]);
    expect(chips(ns)).toBe(0);
    expect(ns.steps[0].subtitle).toBe('Set by the court after filing');
  });

  test('a staff-owned active step does NOT consume the chip — a later client one still gets it', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'staffwork', client_label: 'Staff thing',
            owner: 'staff', sort_order: 1, status: 'active' }),
      req({ requirement_key: 'clientwork', client_label: 'Your thing',
            owner: 'client', sort_order: 2, status: 'active' }),
    ]);
    expect(chips(ns)).toBe(1);
    expect(ns.steps.find(s => s.active_now).label).toBe('Your thing');
  });

  test('an OPTIONAL active step never chips (required=0)', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'opt', client_label: 'Optional thing', required: 0, status: 'active' }),
    ]);
    expect(chips(ns)).toBe(0);
    expect(ns.remaining).toBe(0);       // optional work is not "more steps"
  });

  test('an UPCOMING step never chips — nothing on the current stage is active', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'later', stage_id: 103, client_label: 'Later thing', status: 'upcoming' }),
    ]);
    expect(chips(ns)).toBe(0);
  });

  test('a DONE step never chips even if it somehow arrives owner/required-matching', async () => {
    const ns = build(pipeline(), [
      req({ status: 'done', satisfied_at: new Date('2026-06-01T16:00:00Z') }),
    ]);
    expect(chips(ns)).toBe(0);
    expect(ns.steps[0].done).toBe(true);
  });

  test('zero-active case: every step upcoming → zero chips, card still renders', async () => {
    const ns = build(pipeline({ current: null, upcoming: [S_DOCS, S_FILED] }), [
      req({ status: 'upcoming' }),
      req({ requirement_key: 'f', stage_id: 103, client_label: 'Filing step', status: 'upcoming' }),
    ]);
    expect(chips(ns)).toBe(0);
    expect(ns.steps).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rows: numbering, glyphs, subtitles, dates
// ─────────────────────────────────────────────────────────────────────────────

describe('step rows', () => {
  test('event-kind steps take a calendar glyph and NO number; numbers stay gapless', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'Task one',  sort_order: 1, kind: 'task' }),
      req({ requirement_key: 'b', client_label: 'The meeting', sort_order: 2, kind: 'event',
            owner: 'system', status: 'upcoming' }),
      req({ requirement_key: 'c', client_label: 'Task two',  sort_order: 3, kind: 'task',
            status: 'upcoming' }),
    ]);
    expect(ns.steps.map(s => [s.kind, s.number])).toEqual([
      ['task', 1],
      ['event', null],      // glyph, no number
      ['task', 2],          // NOT 3 — the event consumed nothing
    ]);
  });

  test('done steps carry no number and a firm-local date from satisfied_at', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'Already done', sort_order: 1,
            status: 'done', satisfied_at: new Date('2026-06-10T16:00:00Z'),
            detail: 'Signed' }),
      req({ requirement_key: 'b', client_label: 'Still to do', sort_order: 2 }),
    ]);
    expect(ns.steps[0]).toMatchObject({
      done: true, number: null, date: '2026-06-10', subtitle: 'Signed',
    });
    expect(ns.steps[1]).toMatchObject({ done: false, number: 1, date: null });
  });

  test('subtitle ladder: detail → progress → hint, with effort appended', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'A', sort_order: 1,
            detail: 'Signed', progress: '4 of 7', hint: 'ignored' }),
      req({ requirement_key: 'b', client_label: 'B', sort_order: 2,
            detail: null, progress: '4 of 7 received', hint: 'ignored' }),
      req({ requirement_key: 'c', client_label: 'C', sort_order: 3,
            detail: null, progress: null, hint: 'Initial questionnaire', effort: '~25 min' }),
      req({ requirement_key: 'd', client_label: 'D', sort_order: 4,
            detail: null, progress: null, hint: null, effort: '~5 min' }),
      req({ requirement_key: 'e', client_label: 'E', sort_order: 5,
            detail: null, progress: null, hint: null, effort: null }),
    ]);
    expect(ns.steps.map(s => s.subtitle)).toEqual([
      'Signed',
      '4 of 7 received',
      'Initial questionnaire · ~25 min',
      '~5 min',
      null,
    ]);
  });

  test('CLIENT VOCABULARY OR SILENCE — a missing client_label drops the step, never falls back', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ns = build(pipeline(), [
      req({ requirement_key: 'hole', client_label: null, sort_order: 1 }),
      req({ requirement_key: 'blank', client_label: '   ', sort_order: 2 }),
      req({ requirement_key: 'ok', client_label: 'Upload your documents', sort_order: 3 }),
    ]);
    expect(labels(ns)).toEqual(['Upload your documents']);
    expect(ns.remaining).toBe(1);                 // dropped steps drop out of the count too
    expect(JSON.stringify(ns)).not.toContain('INTERNAL');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('no internal vocabulary or ids anywhere in the card', async () => {
    const ns = build(pipeline(), [req({ status: 'active' })]);
    const keys = new Set(Object.keys(ns.steps[0]));
    for (const forbidden of ['requirement_key', 'stage_key', 'stage_id', 'internal_label',
                             'owner', 'required', 'status', 'override']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(JSON.stringify(ns)).not.toMatch(/INTERNAL|SNAPSHOT|internal note/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The header count
// ─────────────────────────────────────────────────────────────────────────────

describe('header count', () => {
  test('N = remaining REQUIRED client-visible steps (active + upcoming), regardless of owner', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'Done thing', sort_order: 1, status: 'done',
            satisfied_at: new Date('2026-06-01T16:00:00Z') }),        // done → not counted
      req({ requirement_key: 'b', client_label: 'Active thing', sort_order: 2, status: 'active' }),
      req({ requirement_key: 'c', client_label: 'Optional thing', sort_order: 3, required: 0 }),
      req({ requirement_key: 'd', client_label: 'Staff thing', sort_order: 4, owner: 'staff' }),
      req({ requirement_key: 'e', stage_id: 103, client_label: 'Upcoming thing', status: 'upcoming' }),
    ]);
    // active(b) + staff(d) + upcoming(e) = 3; done and optional excluded.
    expect(ns.remaining).toBe(3);
  });

  test('everything done → remaining 0, and the card still renders the ✓ list', async () => {
    const ns = build(pipeline(), [
      req({ requirement_key: 'a', client_label: 'One', sort_order: 1, status: 'done',
            satisfied_at: new Date('2026-06-01T16:00:00Z') }),
    ]);
    expect(ns.remaining).toBe(0);
    expect(ns.steps).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (R2.5) the forward projection — FEATURE-DETECTED
// ─────────────────────────────────────────────────────────────────────────────

describe('projection (R2.5)', () => {
  // R2.5 ships `projected` ONLY on an INTAKE-resolved payload — a lead being
  // shown what happens after retention. A role='case' payload carrying it is a
  // shape production cannot produce, so every fixture here is intake-shaped.
  // The key is ABSENT (not null) on every other payload, which is why the
  // detection is `pipeline.projected` truthiness and never `=== null`.
  const I_CONSULT  = stage('consult_booked', 2, { stage_id: 2, client_label: 'Consultation scheduled' });
  const I_CONTRACT = stage('contract_sent', 5, { stage_id: 18, client_label: 'Agreement sent for signature' });

  function intakePipeline(over = {}) {
    return Object.assign({
      template: { id: 1, name: 'Intake', role: 'intake', case_type: '', case_subtype: '' },
      current: { stage_id: 2, stage_key: 'consult_booked', case_stage: 'Lead',
                 status_label: 'SNAPSHOT consult', entered_at: new Date('2026-08-01T16:00:00Z'),
                 entered_by: 5, source: 'manual', note: 'internal note' },
      history: [],
      upcoming: [I_CONTRACT],
      stages: [I_CONSULT, I_CONTRACT],
    }, over);
  }
  const intakeReq = () => req({ requirement_key: 'submit_questionnaire', stage_id: 2,
                                client_label: 'Complete your questionnaire', status: 'active' });

  // PROJECTED STAGES CARRY NO stage_id — they belong to a template the case has
  // not entered. Reproduced faithfully here; a fixture that invented one would
  // hide a bucketing bug.
  const PROJ = {
    source: 'subtype',
    template: { id: 2, name: 'Bankruptcy — Chapter 7' },
    stages: [
      { stage_key: 'filed', stage_number: 3, internal_label: 'INTERNAL filed',
        client_label: 'Your case is filed', client_visible: 1, lane: 'main' },
      { stage_key: 'review', stage_number: 4, internal_label: 'INTERNAL review',
        client_label: 'Internal review', client_visible: 0, lane: 'main' },
    ],
  };

  test('present on a LEAD → client-visible projected stages ride along, by client_label', async () => {
    const ns = build(intakePipeline({ projected: PROJ }), [intakeReq()]);
    expect(ns.projected).toEqual([{ label: 'Your case is filed' }]);
    // The client_visible=0 projected stage leaves no trace.
    expect(JSON.stringify(ns)).not.toMatch(/Internal review|INTERNAL/);
  });

  test('projected stages NEVER become steps — they carry no stage_id and no requirements', async () => {
    // The projection shares a stage_key with nothing the case has entered, and
    // even a same-KEY collision must not duplicate or invent a step: the step
    // set is bucketed off `current`/`upcoming` stage IDS only.
    const collide = { ...PROJ, stages: [
      { stage_key: 'contract_sent', stage_number: 5, internal_label: 'INTERNAL contract',
        client_label: 'Agreement sent for signature', client_visible: 1, lane: 'main' },
    ] };
    const ns = build(intakePipeline({ projected: collide }), [intakeReq()]);
    expect(ns.steps).toHaveLength(1);
    expect(ns.steps[0].label).toBe('Complete your questionnaire');
    expect(ns.projected).toEqual([{ label: 'Agreement sent for signature' }]);
  });

  test('ABSENT — the key is missing, not null (every non-intake payload) → [] and the card is otherwise identical', async () => {
    const withP  = build(intakePipeline({ projected: PROJ }), [intakeReq()]);
    const without = build(intakePipeline(), [intakeReq()]);
    expect('projected' in intakePipeline()).toBe(false);   // the R2.5 contract
    expect(without.projected).toEqual([]);
    expect(without.steps).toEqual(withP.steps);
    expect(without.remaining).toBe(withP.remaining);
  });

  test('a role=case payload has no projection and renders without one', async () => {
    const ns = build(pipeline(), [req()]);
    expect('projected' in pipeline()).toBe(false);
    expect(ns.projected).toEqual([]);
  });

  test('malformed / empty projected degrades silently rather than throwing', async () => {
    expect(build(intakePipeline({ projected: {} }), [intakeReq()]).projected).toEqual([]);
    expect(build(intakePipeline({ projected: null }), [intakeReq()]).projected).toEqual([]);
    expect(build(intakePipeline({ projected: { source: 'generic', template: null, stages: [] } }),
                 [intakeReq()]).projected).toEqual([]);
  });

  test('a `generic` projection (no matter template resolves) still renders its single stage', async () => {
    const generic = { source: 'generic', template: null, stages: [
      { stage_key: 'retained', stage_number: 10, internal_label: 'Retained',
        client_label: "You've retained us", client_visible: 1, lane: 'main' },
    ] };
    const ns = build(intakePipeline({ projected: generic }), [intakeReq()]);
    expect(ns.projected).toEqual([{ label: "You've retained us" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Degrade paths
// ─────────────────────────────────────────────────────────────────────────────

describe('degrade', () => {
  test('zero requirements → null (the timeline-only page, byte-identical to pre-R3)', async () => {
    expect(build(pipeline(), [])).toBeNull();
    expect(build(pipeline(), null)).toBeNull();
  });

  test('requirements exist but none on a current/upcoming stage → null', async () => {
    const ns = build(pipeline({ current: null, upcoming: [] }), [req()]);
    expect(ns).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCaseView wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('getCaseView wiring', () => {
  function stubDb(rows) {
    return { query: async () => [rows] };
  }
  const CASE_ROW = {
    case_id: 'AbCdEf12', case_chapter: '7', case_type: 'Bankruptcy',
    case_number: '24-1', case_number_full: '24-1-mlo',
    case_341_current: null, case_341_link: '',
  };

  beforeEach(() => {
    portalCardEngine.renderCards.mockResolvedValue([]);
    pipelineService.getPipeline.mockResolvedValue(pipeline());
  });
  afterEach(() => jest.clearAllMocks());

  test('the resolver is called CLIENT-ONLY, pinned to the scope-confirmed case id', async () => {
    requirementService.resolveRequirements.mockResolvedValue(new Map());
    await svc.getCaseView(stubDb([CASE_ROW]), 42, 'abcdef12');
    expect(requirementService.resolveRequirements).toHaveBeenCalledWith(
      expect.anything(), ['AbCdEf12'], { clientOnly: true });
  });

  test('resolved requirements become the card', async () => {
    requirementService.resolveRequirements.mockResolvedValue(
      new Map([['AbCdEf12', [req({ client_label: 'Upload your documents' })]]]));
    const view = await svc.getCaseView(stubDb([CASE_ROW]), 42, 'AbCdEf12');
    expect(view.next_steps.steps).toHaveLength(1);
    expect(view.next_steps.steps[0].active_now).toBe(true);
  });

  test('FAIL-OPEN: a resolver throw degrades to the pre-R3 view, never a 500', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    requirementService.resolveRequirements.mockRejectedValue(new Error('detector table locked'));
    const view = await svc.getCaseView(stubDb([CASE_ROW]), 42, 'AbCdEf12');
    expect(view.next_steps).toBeNull();
    expect(view.timeline).toBeDefined();      // the rest of the page is intact
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('listCases never carries the card (view-only field)', async () => {
    requirementService.resolveRequirements.mockResolvedValue(new Map());
    const rows = await svc.listCases(stubDb([CASE_ROW]), 42);
    expect(Object.keys(rows[0]).sort())
      .toEqual(['case_id', 'current_stage_label', 'docket', 'title']);
    // ...and the list does not pay for a resolve it does not use.
    expect(requirementService.resolveRequirements).not.toHaveBeenCalled();
  });
});
