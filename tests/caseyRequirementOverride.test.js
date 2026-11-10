'use strict';
/**
 * tests/caseyRequirementOverride.test.js
 *
 * A9.4 — Casey marks ONE pipeline step of ONE case N/A or done, or clears its
 * override, through a reviewed card: case.requirement.override.v1 → POST
 * /api/cases/:id/pipeline/requirements/:key/override {status, note} and
 * case.requirement.override.clear.v1 → DELETE on the same path (the case page
 * Steps panel's own n/a / done / clear — requirementService.setOverride /
 * clearOverride).
 *
 * The contract pinned here (mocked services; the real resolver, the real
 * routes, the real case-log row and the real precheck reads run in
 * tests/caseyRequirementOverride.mysql.test.js):
 *   1. the casey_case_pipeline_enabled switch (A9's — no new key);
 *   2. key / shape refusals: unknown fields (a stage rides no override card),
 *      case_id, requirement, status outside na / done, the REQUIRED one-line
 *      note of at most 255 characters by code points AND by UTF-16 units (the
 *      service clips by the latter), evidence;
 *   3. the step: by key, else by label, over BOTH applicable templates
 *      (getCaseRequirements — the route's own read); ambiguous / unknown /
 *      no steps refused by name;
 *   4. refusals that need the read: a set that changes no status (done by
 *      its detector, or the same override), a clear with no override;
 *   5. the disclosures: what the system sees vs what the override declares
 *      (for a replace and a clear, the resolver re-run over a db that hides
 *      THIS override — the shape guard refuses a resolver that does not read
 *      overrides exactly once), A9's gated moves it unblocks / re-blocks
 *      (and the ones other steps still block), the client portal's Next steps
 *      card, the case-log line and set_by, the override replaced / dropped,
 *      a key shared by two steps;
 *   6. `expected`; the ledger receipt;
 *   7. the browser half (lifted from public/assistant.html by name): the fixed
 *      request, the three-read precheck, the result checks, the clear's 404
 *      as a refusal, and the danger rule.
 *
 *   npx jest tests/caseyRequirementOverride.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const svc = require(path.join(REPO, 'services', 'assistantService'));
const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
const caseService = require(path.join(REPO, 'services', 'caseService'));
const pipelineService = require(path.join(REPO, 'services', 'pipelineService'));
const pipelineAdmin = require(path.join(REPO, 'services', 'pipelineAdminService'));
const reqSvc = require(path.join(REPO, 'services', 'requirementService'));
const { normalizeActionDraft } = svc;

const CASE_ID = '7KQ2M9XA';
const OV_SQL = 'SELECT case_id, requirement_key, status, note, set_by, updated_at FROM case_requirement_overrides WHERE case_id IN (?)';

// The steps of the case as the resolver derives them WITHOUT any override:
// Chapter 7 at 'retained' (stage 21, #1), docs (22, #2), filed (23, #3), the
// dismissed off-ramp (29, #90); and the Intake template's history step.
const BASE = () => [
  { requirement_key: 'questionnaire', stage_id: 11, stage_key: 'consult_booked', internal_label: 'Intake questionnaire submitted', client_label: 'Questionnaire', client_visible: 1,
    required: 1, owner: 'client', kind: 'form', hint: null, status: 'done', detail: 'Submitted 2026-03-02', progress: null },
  { requirement_key: 'fee', stage_id: 21, stage_key: 'retained', internal_label: 'Retainer fee paid', client_label: 'Pay your retainer', client_visible: 1,
    required: 1, owner: 'client', kind: 'task', hint: 'Collect the retainer', status: 'active', detail: null, progress: null },
  { requirement_key: 'courtesy', stage_id: 21, stage_key: 'retained', internal_label: 'Courtesy call', client_label: null, client_visible: 0,
    required: 0, owner: 'staff', kind: 'task', hint: null, status: 'active', detail: null, progress: null },
  { requirement_key: 'w2', stage_id: 22, stage_key: 'docs', internal_label: 'W-2s received', client_label: 'Send your W-2s', client_visible: 1,
    required: 1, owner: 'client', kind: 'document', hint: 'Last two years', status: 'upcoming', detail: null, progress: '1 of 2 received' },
  { requirement_key: 'cc_cert', stage_id: 23, stage_key: 'filed', internal_label: 'Credit counseling certificate', client_label: null, client_visible: 1,
    required: 1, owner: 'client', kind: 'document', hint: null, status: 'upcoming', detail: null, progress: null },
];
const STAGE = {
  11: { id: 11, template_id: 1, stage_key: 'consult_booked', internal_label: 'Consult booked', stage_number: 1, lane: 'main' },
  21: { id: 21, template_id: 2, stage_key: 'retained', internal_label: 'Retained', stage_number: 1, lane: 'main' },
  22: { id: 22, template_id: 2, stage_key: 'docs', internal_label: 'Docs requested', stage_number: 2, lane: 'main' },
  23: { id: 23, template_id: 2, stage_key: 'filed', internal_label: 'Filed', stage_number: 3, lane: 'main' },
  29: { id: 29, template_id: 2, stage_key: 'dismissed', internal_label: 'Dismissed', stage_number: 90, lane: 'offramp' },
};
const DETECTOR = { questionnaire: 'form', fee: 'manual', courtesy: 'manual', w2: 'checklist', cc_cert: 'manual' };

// The resolver's precedence over BASE: an override row wins (rule 1).
function resolve(base, ovRows) {
  return base.map((r) => {
    const o = ovRows.find((x) => x.requirement_key === r.requirement_key);
    return { ...r, status: o ? o.status : r.status, override: o ? { status: o.status, note: o.note, set_by: o.set_by, at: o.updated_at } : null };
  });
}

let spies = [];
function setup({ caseRow = {}, base = BASE(), overrides = [], pipe, resolverReads = 1, current = 'retained', resolverIgnoresHiding = false } = {}) {
  const row = { case_id: CASE_ID, case_number: '25-12345', case_number_full: '25-12345-abc', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case', ...caseRow };
  const ovTable = overrides.map((o) => ({ case_id: CASE_ID, note: null, set_by: 6, updated_at: new Date('2026-11-01T14:30:00Z'), ...o }));
  const chapter = (rows) => [21, 22, 23, 29].map((sid) => ({ stage_id: sid, stage_key: STAGE[sid].stage_key, internal_label: STAGE[sid].internal_label,
    stage_number: STAGE[sid].stage_number, lane: STAGE[sid].lane, requirements: rows.filter((r) => r.stage_id === sid) }));
  const resolved = () => resolve(base, ovTable);
  const pipeNow = pipe || {
    template: { id: 2, name: 'Chapter 7', role: 'case' },
    current: current ? { stage_key: current } : null,
    history: current ? [{ stage_key: current }] : [],
    stages: chapter(resolved()),
    upcoming: [21, 22, 23].filter((sid) => !current || STAGE[sid].stage_number > Object.values(STAGE).find((x) => x.template_id === 2 && x.stage_key === current).stage_number)
      .map((sid) => ({ stage_id: sid, stage_key: STAGE[sid].stage_key })),
  };
  spies = [
    jest.spyOn(caseService, 'getCase').mockImplementation(async (_db, id, include) => {
      expect(include).toBe('contacts');
      if (String(id) !== CASE_ID) return null;
      return { case: { ...row }, clients: [{ contact_name: 'Dana Debtor', relate_type: 'Primary' }] };
    }),
    jest.spyOn(reqSvc, 'getCaseRequirements').mockImplementation(async (_db, id) => { expect(id).toBe(CASE_ID); return resolved(); }),
    // The resolver re-run: reads overrides THROUGH the db it is handed (the
    // card's hiding wrapper), `resolverReads` times, and resolves over them.
    jest.spyOn(reqSvc, 'resolveRequirements').mockImplementation(async (db, ids) => {
      expect(ids).toEqual([CASE_ID]);
      let ov = [];
      for (let i = 0; i < resolverReads; i++) [ov] = await db.query(OV_SQL, [ids]);
      // A resolver that read the overrides once (shape fine) but did not resolve over what it was handed.
      if (resolverIgnoresHiding) ov = ovTable.map((o) => ({ ...o }));
      return new Map([[CASE_ID, resolve(base, ov)]]);
    }),
    jest.spyOn(pipelineService, 'getPipeline').mockImplementation(async (_db, id, opts) => {
      expect([id, opts]).toEqual([CASE_ID, { requirements: true }]);
      return JSON.parse(JSON.stringify(pipeNow));
    }),
    jest.spyOn(pipelineAdmin, 'listRequirements').mockImplementation(async (_db, sid) => ({
      stage: { ...STAGE[sid] }, requirements: base.filter((r) => r.stage_id === sid).map((r) => ({ requirement_key: r.requirement_key, detector: DETECTOR[r.requirement_key], active: 1 })),
    })),
    jest.spyOn(pipelineAdmin, 'listTemplates').mockImplementation(async () => [{ id: 1, name: 'Intake', active: 1 }, { id: 2, name: 'Chapter 7', active: 1 }]),
  ];
  const query = jest.fn(async (sql, params) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    if (flat === OV_SQL) { expect(params).toEqual([[CASE_ID]]); return [ovTable.map((o) => ({ ...o })), []]; }
    if (flat === 'SELECT user, user_name FROM users WHERE user = ? LIMIT 1') return [params[0] === 6 ? [{ user: 6, user_name: 'Fred' }] : []];
    throw new Error(`unexpected query: ${flat}`);
  });
  return { query };
}
afterEach(() => { spies.forEach((s) => s.mockRestore()); spies = []; delete process.env.CASEY_CASE_PIPELINE_ENABLED; });

const EVIDENCE = [{ id: 'q1', purpose: 'case', rows: [{ case_id: CASE_ID, case_number: '25-12345' }, { case_id: 'OTHER123' }] }];
const ev = [{ query_id: 'q1', row_number: 1 }];
const set = (requirement, status, note, over = {}) => ({ kind: 'case.requirement.override.v1', case_id: CASE_ID, requirement, status, note, evidence: ev, ...over });
const clear = (requirement, over = {}) => ({ kind: 'case.requirement.override.clear.v1', case_id: CASE_ID, requirement, evidence: ev, ...over });
const run = (value, opts, evidence = EVIDENCE) => normalizeActionDraft(setup(opts), value, evidence, { currentUserId: 6 });
const refuse = (value, re, opts, evidence) => expect(run(value, opts, evidence)).rejects.toThrow(re);

describe('the switch and the keys', () => {
  test("A9's switch: '0' makes both override kinds unavailable; unset is ON", async () => {
    process.env.CASEY_CASE_PIPELINE_ENABLED = '0';
    await expect(run(set('fee', 'na', 'paid in cash'))).rejects.toThrow(/^Action kind is unavailable$/);
    await expect(run(clear('fee'), { overrides: [{ requirement_key: 'fee', status: 'na' }] })).rejects.toThrow(/^Action kind is unavailable$/);
    delete process.env.CASEY_CASE_PIPELINE_ENABLED;
    await expect(run(set('fee', 'na', 'paid in cash'))).resolves.toMatchObject({ kind: 'case.requirement.override.v1', status: 'draft' });
  });

  test('unsupported fields are refused before anything is read — a stage never rides an override card', async () => {
    await refuse(set('fee', 'na', 'x', { stage: 'docs' }), /^A requirement override carries unsupported fields: stage — it takes case_id, requirement, status, note, evidence only: ONE step of ONE case, nothing else \(a stage move, an advance or a transfer is its own card — one card, one override\)$/);
    await refuse(clear('fee', { status: 'na' }), /^A requirement override clear carries unsupported fields: status — it takes case_id, requirement, evidence only/);
    await refuse(clear('fee', { note: 'why' }), /unsupported fields: note/);
    expect(caseService.getCase).not.toHaveBeenCalled();
  });

  test('shape refusals: case_id, requirement, status, evidence', async () => {
    await refuse(set('fee', 'na', 'x', { case_id: 'bad id!' }), /needs the case's exact case_id/);
    await refuse(set('', 'na', 'x'), /needs "requirement": the step's requirement_key or label/);
    await refuse(set(7, 'na', 'x'), /needs "requirement"/);
    for (const bad of ['active', 'skipped', 'N/A', 'complete', '', null]) {
      await refuse(set('fee', bad, 'x'), /^An override's status is "na" \(not applicable\) or "done" — got .*Every other status \(active, upcoming, skipped\) is derived/);
    }
    // Case-folded, trimmed.
    await expect(run(set('fee', ' DONE ', 'paid'))).resolves.toMatchObject({ override_status: 'done' });
    await refuse(set('fee', 'na', 'x', { evidence: [{ query_id: 'q1', row_number: 2 }] }), /evidence does not identify case 7KQ2M9XA/);
  });

  test('THE NOTE IS REQUIRED, one line, at most 255 characters by code points AND by UTF-16 units', async () => {
    await refuse(set('fee', 'na', undefined), /^An override needs "note": the reason, in the user's words/);
    await refuse(set('fee', 'na', '   '), /^An override needs "note"/);
    await refuse(set('fee', 'na', 5), /^An override needs "note"/);
    await refuse(set('fee', 'na', 'paid\nin cash'), /^The override note is one line of text/);
    await refuse(set('fee', 'na', 'x'.repeat(256)), /^The override note is 256 characters — the override keeps 255 and the route would cut it short silently/);
    await expect(run(set('fee', 'na', 'x'.repeat(255)))).resolves.toMatchObject({ note: 'x'.repeat(255) });
    // 200 emoji: 200 code points, 400 UTF-16 units — setOverride's clip would cut it.
    await refuse(set('fee', 'na', '\u{1F600}'.repeat(200)), /^The override note is 200 characters \(400 UTF-16 units\)/);
    // Trimmed before it is counted and sent.
    await expect(run(set('fee', 'na', '  paid in cash  '))).resolves.toMatchObject({ note: 'paid in cash' });
  });

  test('an unknown case is refused', async () => {
    await refuse(set('fee', 'na', 'x', { case_id: 'NOPE1234' }), /^Case NOPE1234 no longer exists$/, undefined, [{ id: 'q1', rows: [{ case_id: 'NOPE1234' }] }]);
  });
});

describe('the step: by key, else by label, over both applicable templates', () => {
  test('by key (case-insensitive) and by label; an intake-history step resolves too', async () => {
    await expect(run(set('FEE', 'na', 'x'))).resolves.toMatchObject({ requirement: { requirement_key: 'fee', internal_label: 'Retainer fee paid', required: 1 } });
    await expect(run(set('retainer fee paid', 'na', 'x'))).resolves.toMatchObject({ requirement: { requirement_key: 'fee' } });
    const c = await run(set('questionnaire', 'na', 'not needed for this client'));
    expect(c.rows).toEqual([expect.objectContaining({ stage_id: 11, stage_label: 'Consult booked', template_name: 'Intake', on_pipeline: false, status: 'done', after_status: 'na' })]);
    expect(c.effects).toContain('Pipeline moves: the override unblocks no move on Casey\'s pipeline cards (the step is on Intake, not the pipeline the case resolves to).');
  });

  test('a label two different keys share is refused naming both; an unknown step lists the live ones; no steps at all is refused', async () => {
    const twin = [...BASE(), { ...BASE()[1], requirement_key: 'fee2', stage_id: 22, stage_key: 'docs' }];
    await refuse(set('Retainer fee paid', 'na', 'x'), /^"Retainer fee paid" names 2 different steps of case 25-12345-abc: "Retainer fee paid" \(fee, stage retained, active\), "Retainer fee paid" \(fee2, stage docs, active\) — name it by its requirement_key$/, { base: twin });
    await refuse(set('tax returns', 'na', 'x'), /^"tax returns" is not a step of case 25-12345-abc's pipeline — its steps are: "Intake questionnaire submitted" \(questionnaire, done\), "Retainer fee paid" \(fee, active\), "Courtesy call" \(courtesy, active\), "W-2s received" \(w2, upcoming\), "Credit counseling certificate" \(cc_cert, upcoming\)\. A case.pipeline read shows each step/);
    await refuse(set('fee', 'na', 'x'), /^Case 25-12345-abc has no pipeline steps — there is nothing to mark done or N\/A$/, { base: [] });
  });

  test('ONE KEY, TWO STEPS: a key both templates carry is marked on both, and the card says so', async () => {
    const shared = [...BASE(), { ...BASE()[0], stage_id: 22, stage_key: 'docs', status: 'upcoming', detail: null }];
    const c = await run(set('questionnaire', 'na', 'waived by Stuart'), { base: shared });
    expect(c.rows.map((r) => [r.stage_id, r.status, r.after_status])).toEqual([[11, 'done', 'na'], [22, 'upcoming', 'na']]);
    expect(c.effects).toContain('One key, 2 steps: "questionnaire" is carried by stage Consult booked on Intake and stage Docs requested on Chapter 7 — an override binds by key, so it marks all of them at once.');
  });
});

describe('refusals that need the read', () => {
  test('a "done" override on a step its detector already finds done is refused, naming the detector', async () => {
    await refuse(set('questionnaire', 'done', 'x'), /^"Intake questionnaire submitted" on case 25-12345-abc is already done — its detector \(Form submitted \(form_submissions\)\) finds it done: Submitted 2026-03-02 — so a "done" override changes nothing/);
  });

  test('the IDENTICAL override (same status, same note) is refused — nothing to change', async () => {
    await refuse(set('fee', 'na', '  old reason '), /^"Retainer fee paid" on case 25-12345-abc is already marked N\/A by an override with this same note \("old reason"\) — there is nothing to change$/,
      { overrides: [{ requirement_key: 'fee', status: 'na', note: 'old reason' }] });
  });

  test('NOTE ONLY (coordinator ruling): same status, a different note is a card — status unchanged, old note → new, no gate / portal / danger change', async () => {
    const c = await run(set('fee', 'na', 'new reason'), { overrides: [{ requirement_key: 'fee', status: 'na', note: 'old reason' }] });
    expect(c).toMatchObject({ note_only: true, override_status: 'na', note: 'new reason', log_line: 'Requirement fee: marked N/A (override) - new reason',
      gate: { unblocks: [], reblocks: [], still: [] }, warnings: [] });
    expect(c.rows[0]).toMatchObject({ status: 'na', derived_status: 'active', after_status: 'na' });
    expect(c.effects).toEqual(expect.arrayContaining([
      'NOTE ONLY: status unchanged (N/A); note replaced: "old reason" → "new reason". The override was N/A, set by Fred (user #6) on 2026-11-01 09:30 firm time, with the note "old reason"; only its note and set_by change (the case-log row written when it was set stays, and this one adds a new line).',
      'Client portal: "Pay your retainer" stays hidden on the client\'s Next steps card.',
      'Case log: one "status" row on the case, by you (user #6), reading "Requirement fee: marked N/A (override) - new reason". The override row records set_by = you (user #6) (an API key would record 0). The log write is fire-and-forget: if it fails, the override still stands.',
    ]));
    expect(c.effects.some((e) => /^REPLACES the existing override/.test(e))).toBe(false);
    // A previous override with NO note: any note is a note-only change.
    const fromNone = await run(set('fee', 'done', 'paid'), { overrides: [{ requirement_key: 'fee', status: 'done', note: null }] });
    expect(fromNone.note_only).toBe(true);
    expect(fromNone.effects.find((e) => /^NOTE ONLY/.test(e))).toMatch(/^NOTE ONLY: status unchanged \(done\); note replaced: \(none\) → "paid"\./);
    // A real status change over an existing override is not note-only.
    const changed = await run(set('fee', 'done', 'new reason'), { overrides: [{ requirement_key: 'fee', status: 'na', note: 'old reason' }] });
    expect(changed.note_only).toBe(false);
    expect(changed.effects.some((e) => /^REPLACES the existing override/.test(e))).toBe(true);
    expect(changed.warnings[0]).toMatch(/^REQUIRED STEP MARKED DONE ON YOUR WORD/);
  });

  test('a clear with no override is refused (the route 404s; the panel shows no button)', async () => {
    await refuse(clear('fee'), /^"Retainer fee paid" on case 25-12345-abc has no override to clear — it reads active by the system's own reckoning \(a manual step — no detector watches it, so only an override can mark it done or N\/A \(it asks: Collect the retainer\)\)\. The route answers 404 and the Steps panel shows no clear button/);
  });
});

describe('the set card: what the system sees, what it unblocks, the portal, the log', () => {
  test('a REQUIRED manual step marked N/A: the manufactured warning, the moves it unblocks and the one still blocked, the portal, the log line and set_by', async () => {
    const c = await run(set('fee', 'na', 'Paid in cash at the consult'));
    expect(c).toMatchObject({
      kind: 'case.requirement.override.v1', override_status: 'na', note: 'Paid in cash at the consult', existing: null,
      pipeline: { template_id: 2, name: 'Chapter 7', role: 'case' },
      log_line: 'Requirement fee: marked N/A (override) - Paid in cash at the consult',
      gate: { unblocks: ['Docs requested (docs) — its next stage'], reblocks: [], still: [{ move: 'Filed (filed)', others: ['"W-2s received" (stage Docs requested, upcoming)'] }] },
    });
    expect(c.rows).toEqual([expect.objectContaining({ stage_id: 21, stage_number: 1, on_pipeline: true, detector: 'manual', detector_label: 'Manual (override only)', status: 'active', derived_status: 'active', after_status: 'na' })]);
    expect(c.sees).toEqual(['"Retainer fee paid" (stage Retained, required, client): the system sees active — a manual step — no detector watches it, so only an override can mark it done or N/A (it asks: Collect the retainer); the override declares it N/A.']);
    expect(c.warnings).toEqual([
      'REQUIRED STEP MARKED N/A ON YOUR WORD: "Retainer fee paid" (stage Retained, required, client) — the system does not see it done (it reads active); the override makes it read N/A with the note as the only reason on record.',
      'UNBLOCKS: Casey\'s pipeline cards refuse a move past an open REQUIRED step; with "Retainer fee paid" marked N/A they no longer refuse a move to Docs requested (docs) — its next stage.',
    ]);
    expect(c.effects).toEqual(expect.arrayContaining([
      'Still blocked either way: a move to Filed (filed) — "W-2s received" (stage Docs requested, upcoming) blocks it too.',
      'The case page\'s own Advance and the pipeline board\'s drag check no requirement at all, so there the override changes only what the Steps panel shows: "Retainer fee paid" reads N/A with an N/A chip and the note under it.',
      'Client portal: "Pay your retainer" goes from shown as still to do to hidden on the client\'s Next steps card, and the count of steps remaining changes with it.',
      'Case log: one "status" row on the case, by you (user #6), reading "Requirement fee: marked N/A (override) - Paid in cash at the consult". The override row records set_by = you (user #6) (an API key would record 0). The log write is fire-and-forget: if it fails, the override still stands.',
      'Automation: neither route emits an event — no trigger rule runs.',
    ]));
    // The dismissed off-ramp is never a gated move.
    expect(JSON.stringify(c.gate)).not.toContain('dismissed');
    expect(c.expected).toEqual({
      case_id: CASE_ID, pipeline_phase: 'case', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', template_id: 2, stage_key: 'retained', history_count: 1,
      requirement_key: 'fee', rows: [{ stage_id: 21, stage_key: 'retained', stage_number: 1, on_pipeline: true, status: 'active', derived_status: 'active' }], override: null,
      signature: ['cc_cert@23:upcoming:1:-', 'courtesy@21:active:0:-', 'fee@21:active:1:-', 'questionnaire@11:done:1:-', 'w2@22:upcoming:1:-'],
    });
    // No resolver re-run without an override to hide.
    expect(reqSvc.resolveRequirements).not.toHaveBeenCalled();
  });

  test('an OPTIONAL staff-only step: no warning, nothing unblocked, the portal never shows it', async () => {
    const c = await run(set('courtesy', 'done', 'called Tuesday'));
    expect(c.warnings).toEqual([]);
    expect(c.gate).toEqual({ unblocks: [], reblocks: [], still: [] });
    expect(c.effects).toEqual(expect.arrayContaining([
      'Pipeline moves: the override unblocks no move on Casey\'s pipeline cards (the step is optional, active now and done after, behind no gated move).',
      '"Courtesy call" (stage Retained, optional, staff) is staff-only — the client portal never shows it.',
    ]));
  });

  test('a client-visible step with no client label, and one off the Next steps stages, say the portal does not change', async () => {
    const c = await run(set('cc_cert', 'done', 'certificate in the file'));
    expect(c.effects).toContain('"Credit counseling certificate" (stage Filed, required, client) is client-visible but has no client label, so the portal drops it either way.');
    // With the case at 'filed', docs is behind it: the Next steps card lists only filed's steps.
    const off = await run(set('w2', 'na', 'no W-2 income'), { current: 'filed' });
    expect(off.effects).toContain('"W-2s received" (stage Docs requested, required, client) is client-visible, but its stage is not the case\'s current or an upcoming main-lane stage, so the client\'s Next steps card does not list it either way.');
    // An UPCOMING stage's client-visible step is on the card.
    const up = await run(set('w2', 'na', 'no W-2 income'));
    expect(up.effects).toContain('Client portal: "Send your W-2s" goes from shown as still to do to hidden on the client\'s Next steps card, and the count of steps remaining changes with it.');
  });

  test('A SET OVER AN EXISTING OVERRIDE: the derived status comes from the resolver re-run with THIS override hidden; the one it replaces is named with who and when', async () => {
    const c = await run(set('w2', 'done', 'both W-2s are in the file'), { overrides: [{ requirement_key: 'w2', status: 'na', note: 'no W-2 income', set_by: 6 }, { requirement_key: 'fee', status: 'done', note: 'paid' }] });
    // The hiding wrapper removed ONLY w2's row: fee's override still applies inside the re-run.
    const projected = await reqSvc.resolveRequirements.mock.results[0].value;
    expect(projected.get(CASE_ID).map((r) => [r.requirement_key, r.status])).toEqual([['questionnaire', 'done'], ['fee', 'done'], ['courtesy', 'active'], ['w2', 'upcoming'], ['cc_cert', 'upcoming']]);
    expect(c.rows[0]).toMatchObject({ status: 'na', derived_status: 'upcoming', after_status: 'done', progress: '1 of 2 received' });
    expect(c.sees[0]).toBe('"W-2s received" (stage Docs requested, required, client): the system sees upcoming (it reads N/A now, by the override this replaces) — its detector (Checklist complete (by tag)) does not find it done: 1 of 2 received (it asks: Last two years); the override declares it done.');
    expect(c.existing).toEqual({ status: 'na', note: 'no W-2 income', set_by: 6, set_by_text: 'Fred (user #6)', at: '2026-11-01T14:30:00.000Z', at_text: '2026-11-01 09:30 firm time' });
    expect(c.effects).toContain('REPLACES the existing override: N/A, set by Fred (user #6) on 2026-11-01 09:30 firm time, with the note "no W-2 income" — its status and note are overwritten (the case-log row written when it was set stays).');
    // N/A → done: neither status blocks, so no move changes.
    expect(c.gate).toEqual({ unblocks: [], reblocks: [], still: [] });
    expect(c.expected.override).toEqual({ status: 'na', note: 'no W-2 income', set_by: 6, at: '2026-11-01T14:30:00.000Z' });
  });

  test('an override set by an API key (set_by 0) is named as such', async () => {
    const c = await run(set('w2', 'done', 'in'), { overrides: [{ requirement_key: 'w2', status: 'na', set_by: 0 }] });
    expect(c.existing).toMatchObject({ set_by: 0, set_by_text: 'an API key or automation (set_by 0)', note: null });
  });

  test('THE SHAPE GUARD: a resolver that does not read overrides exactly once refuses the card — it would project the override itself', async () => {
    for (const reads of [0, 2]) {
      await refuse(set('w2', 'done', 'in'), /^Casey could not work out what "W-2s received" would read without its override/, { overrides: [{ requirement_key: 'w2', status: 'na' }], resolverReads: reads });
    }
    await expect(run(set('w2', 'done', 'in'), { overrides: [{ requirement_key: 'w2', status: 'na' }], resolverReads: 1 })).resolves.toMatchObject({ kind: 'case.requirement.override.v1' });
  });

  test('THE PROJECTION GUARD: a resolver that read the overrides once but whose projected row STILL carries this override refuses the card — the hiding did not reach it (manager addition at landing, 2026-11-10)', async () => {
    for (const value of [set('w2', 'done', 'in'), clear('w2')]) {
      await refuse(value, /^Casey could not work out what "W-2s received" would read without its override/, { overrides: [{ requirement_key: 'w2', status: 'na' }], resolverIgnoresHiding: true });
    }
  });

  test('the retention crossing: an intake lead\'s open required step blocks entering its chapter pipeline', async () => {
    const intakePipe = {
      template: { id: 1, name: 'Intake', role: 'intake' }, current: { stage_key: 'consult_booked' }, history: [{}],
      stages: [{ stage_id: 11, stage_key: 'consult_booked', internal_label: 'Consult booked', stage_number: 1, lane: 'main',
        requirements: [{ requirement_key: 'questionnaire', stage_id: 11, internal_label: 'Intake questionnaire submitted', required: 1, status: 'active' }] }],
      upcoming: [],
    };
    const base = [{ ...BASE()[0], status: 'active', detail: null }];
    const c = await run(set('questionnaire', 'na', 'consult done by phone'), { base, pipe: intakePipe, caseRow: { pipeline_phase: 'intake' } });
    expect(c.gate.unblocks).toEqual(['its chapter pipeline\'s first stage (retaining the lead — the crossing passes every intake step)']);
    // A retained case shown on the Intake pipeline: A9 refuses every move there for another reason.
    const m = await run(set('questionnaire', 'na', 'consult done by phone'), { base, pipe: intakePipe, caseRow: { pipeline_phase: 'case' } });
    expect(m.gate).toEqual({ unblocks: [], reblocks: [], still: [] });
    expect(m.effects[0]).toMatch(/^Pipeline moves: none change — Casey's pipeline cards refuse every move of this retained case on the Intake pipeline/);
  });
});

describe('the clear card: the status it returns to, what it re-blocks, what it drops', () => {
  test('a REQUIRED step returning to active: the reopened warning, the re-block, the portal, the dropped note', async () => {
    const c = await run(clear('fee'), { overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid in cash' }] });
    expect(c).toMatchObject({ kind: 'case.requirement.override.clear.v1', override_status: null, note: null, log_line: 'Requirement fee: override cleared',
      gate: { unblocks: [], reblocks: ['Docs requested (docs) — its next stage'], still: [{ move: 'Filed (filed)', others: ['"W-2s received" (stage Docs requested, upcoming)'] }] } });
    expect(c.rows[0]).toMatchObject({ status: 'done', derived_status: 'active', after_status: 'active' });
    expect(c.sees).toEqual(['"Retainer fee paid" (stage Retained, required, client): now done by the override; once cleared it reads active — a manual step — no detector watches it, so only an override can mark it done or N/A (it asks: Collect the retainer).']);
    expect(c.warnings).toEqual([
      'REQUIRED STEP REOPENED: "Retainer fee paid" (stage Retained, required, client) reads active again once the override is gone — the system does not see it done.',
      'RE-BLOCKS: once cleared, "Retainer fee paid" blocks Casey\'s pipeline cards from moving the case to Docs requested (docs) — its next stage until it is done or N/A again.',
    ]);
    expect(c.effects).toEqual(expect.arrayContaining([
      'Client portal: "Pay your retainer" goes from shown as done to shown as still to do on the client\'s Next steps card, and the count of steps remaining changes with it.',
      'Drops the override: done, set by Fred (user #6) on 2026-11-01 09:30 firm time, with the note "paid in cash" — the note goes with it (the case-log row written when it was set stays).',
      'Case log: one "status" row on the case, by you (user #6), reading "Requirement fee: override cleared". The override row is deleted. The log write is fire-and-forget: if it fails, the clear still stands.',
    ]));
  });

  test('a step its detector finds done: the clear returns it to done — no warning, nothing re-blocked', async () => {
    const c = await run(clear('questionnaire'), { overrides: [{ requirement_key: 'questionnaire', status: 'na' }] });
    expect(c.rows[0]).toMatchObject({ status: 'na', derived_status: 'done', after_status: 'done', detail: 'Submitted 2026-03-02' });
    expect(c.warnings).toEqual([]);
    expect(c.sees[0]).toMatch(/once cleared it reads done — its detector \(Form submitted \(form_submissions\)\) finds it done: Submitted 2026-03-02\.$/);
  });
});

describe('A9 / A9.3 touch: the pipeline cards still never override, and point here', () => {
  test('an override-shaped key on an advance, a move or a transfer is refused by name and names this kind', async () => {
    const db = setup();
    for (const value of [{ kind: 'case.pipeline.advance.v1', case_id: CASE_ID, mark_na: ['fee'], evidence: ev },
      { kind: 'case.pipeline.move.v1', case_id: CASE_ID, stage: 'docs', override: true, evidence: ev }]) {
      await expect(normalizeActionDraft(db, value, EVIDENCE, { currentUserId: 6 })).rejects.toThrow(
        /— Casey has no override pathway on a pipeline card\. Marking a step done or N\/A is its OWN card: propose case\.requirement\.override\.v1 \{case_id, requirement, status, note\} for that one step .*never both in one card$/);
    }
    await expect(normalizeActionDraft(db, { kind: 'case.pipeline.transfer.v1', case_id: CASE_ID, pipeline: 'Chapter 13', waive: true, evidence: ev }, EVIDENCE, { currentUserId: 6 }))
      .rejects.toThrow(/marking a step of the case's pipeline done or N\/A is its own card, case\.requirement\.override\.v1/);
    expect(caseService.getCase).not.toHaveBeenCalled();
  });

  test('the case.pipeline read names the override cards where it used to say Casey cannot override', async () => {
    const db = setup();
    // The read asks getCase for the case row only (no contacts include).
    caseService.getCase.mockImplementation(async () => ({ case: { case_id: CASE_ID, case_number: '25-12345', case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case' } }));
    const out = await svc.casePipelineRead(db, CASE_ID);
    expect(out.rows[0].note).toContain('marking a step done or N/A is its own card — case.requirement.override.v1, one step at a time, with the reason — and clearing an override is case.requirement.override.clear.v1.');
    expect(out.rows[0].note).not.toContain('Casey cannot override one');
  });
});

describe('the ledger', () => {
  test('both kinds receipt the STRING case_id', () => {
    expect(ledger.KINDS.get('case.requirement.override.v1')).toBe('case_id');
    expect(ledger.KINDS.get('case.requirement.override.clear.v1')).toBe('case_id');
  });
});

// ── The browser half, lifted from public/assistant.html by name ────────────
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
function familySrc(id) {
  const at = html.indexOf(`id: '${id}'`);
  if (at < 0) throw new Error(`family ${id} not found`);
  const open = html.lastIndexOf('\n  {', at) + 3;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open, i + 1);
  }
  throw new Error(`family ${id} unbalanced`);
}
const FNS = ['actionStringReceipt', 'casePipelineCaseLabel', 'caseOverrideLabel', 'caseOverrideWord', 'caseOverrideDanger', 'caseOverrideText',
  'caseOverrideRequest', 'caseOverridePrecheck', 'caseOverrideResult', 'caseOverrideKnownOutcome'];
function browser(api) {
  const src = [constSrc('CASE_REQUIREMENT_OVERRIDE_ACTION_KINDS'), constSrc('CASE_OVERRIDE_KEY'), constSrc('CASE_PIPELINE_OPEN'), ...FNS.map(fnSrc),
    `const family = ${familySrc('case_requirement_override')};`, `return { ${FNS.join(', ')}, family };`].join('\n');
  return new Function('api', 'openEntity', src)(api, jest.fn()); // eslint-disable-line no-new-func
}

describe('the browser: the fixed request, the three-read precheck, the result checks, outcomes, danger', () => {
  let setCard; let clearCard; let replaceCard;
  beforeAll(async () => {
    const mk = async (value, opts) => {
      const c = await run(value, opts);
      spies.forEach((s) => s.mockRestore()); spies = [];
      return JSON.parse(JSON.stringify(c));
    };
    setCard = await mk(set('fee', 'na', 'Paid in cash at the consult'));
    clearCard = await mk(clear('fee'), { overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid', set_by: 6 }] });
    replaceCard = await mk(set('w2', 'done', 'both in'), { overrides: [{ requirement_key: 'w2', status: 'na', note: 'none', set_by: 6 }] });
  });

  // The three GETs as the real routes answer them, built from the same fixtures.
  function reads({ overrides = [], base = BASE(), pipeOver = {}, caseOver = {} } = {}) {
    const ovRows = overrides.map((o) => ({ note: null, set_by: 6, updated_at: '2026-11-01T14:30:00.000Z', ...o }));
    const rows = resolve(base, ovRows);
    const gets = [];
    const api = jest.fn(async (p, body, method) => {
      expect([body, method]).toEqual([null, 'GET']);
      gets.push(p);
      if (p === `/api/cases/${CASE_ID}/pipeline/requirements`) return { status: 'success', requirements: rows };
      if (p === `/api/cases/${CASE_ID}/pipeline`) {
        return { status: 'success', template: { id: 2 }, current: { stage_key: 'retained' }, history: [{}],
          stages: [21, 22, 23, 29].map((sid) => ({ stage_id: sid, stage_key: STAGE[sid].stage_key, stage_number: STAGE[sid].stage_number })), ...pipeOver };
      }
      if (p === `/api/cases/${CASE_ID}`) return { case: { case_id: CASE_ID, case_type: 'Bankruptcy', case_subtype: 'Chapter 7', pipeline_phase: 'case', ...caseOver } };
      throw new Error(`unexpected read ${p}`);
    });
    return { api, gets };
  }
  const PATH = `/api/cases/${CASE_ID}/pipeline/requirements/fee/override`;

  test('the request: POST {status, note} for a set, DELETE with no body for a clear — nothing else from the draft', () => {
    const b = browser(jest.fn());
    expect(b.caseOverrideRequest({ ...setCard, stage: 'filed', requirement_key: 'other', status: 'done' })).toEqual({ path: PATH, method: 'POST', body: { status: 'na', note: 'Paid in cash at the consult' } });
    expect(b.caseOverrideRequest(clearCard)).toEqual({ path: PATH, method: 'DELETE', body: null });
    expect(() => b.caseOverrideRequest({ ...setCard, requirement: { requirement_key: 'Fee/../x' } })).toThrow('This card has no usable step key.');
    expect(() => b.caseOverrideRequest({ ...setCard, case: { case_id: 'bad id!' } })).toThrow('This card has no usable case id.');
    expect(() => b.caseOverrideRequest({ ...setCard, override_status: 'active' })).toThrow('This card has no usable override status.');
    expect(() => b.caseOverrideRequest({ ...setCard, note: '  ' })).toThrow('This card has no reason (note).');
    expect(() => b.caseOverrideRequest({ ...setCard, note: 'x'.repeat(256) })).toThrow('This card\'s note is longer than the override keeps.');
    expect(() => b.caseOverrideRequest({ ...setCard, note: '\u{1F600}'.repeat(128) })).toThrow('This card\'s note is longer than the override keeps.');
    expect(() => b.caseOverrideRequest({ ...setCard, kind: 'case.requirement.override.v2' })).toThrow('This override card has an unknown kind.');
  });

  test('the precheck: three reads in order, a fresh card passes', async () => {
    const { api, gets } = reads();
    await expect(browser(api).caseOverridePrecheck(setCard)).resolves.toBe('');
    expect(gets).toEqual([`/api/cases/${CASE_ID}/pipeline/requirements`, `/api/cases/${CASE_ID}/pipeline`, `/api/cases/${CASE_ID}`]);
    await expect(browser(reads({ overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid' }] }).api).caseOverridePrecheck(clearCard)).resolves.toBe('');
    await expect(browser(reads({ overrides: [{ requirement_key: 'w2', status: 'na', note: 'none' }] }).api).caseOverridePrecheck(replaceCard)).resolves.toBe('');
  });

  test.each([
    ['an override set since (set card)', setCard_ => [setCard_, { overrides: [{ requirement_key: 'fee', status: 'done', note: 'x' }] }], /^The override on "Retainer fee paid" for case 25-12345-abc changed since this card was prepared \(now done, note "x"\)/],
    ['the override cleared since (clear card)', (_s, c) => [c, {}], /^The override on "Retainer fee paid" for case 25-12345-abc changed since this card was prepared \(now none\)/],
    ['the override\'s note changed (clear card)', (_s, c) => [c, { overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid!' }] }], /^The override on "Retainer fee paid".*changed/],
    ['the override\'s author changed (clear card)', (_s, c) => [c, { overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid', set_by: 1 }] }], /^The override on "Retainer fee paid".*changed/],
    ['the override re-set at another time (clear card)', (_s, c) => [c, { overrides: [{ requirement_key: 'fee', status: 'done', note: 'paid', updated_at: '2026-11-02T00:00:00.000Z' }] }], /^The override on "Retainer fee paid".*changed/],
    ['the step\'s status changed (now done by its detector)', (s) => [s, { base: BASE().map((r) => (r.requirement_key === 'fee' ? { ...r, status: 'done' } : r)) }], /^"Retainer fee paid" on case 25-12345-abc changed since this card was prepared \(it now reads done\)/],
    ['the step gone from the case', (s) => [s, { base: BASE().filter((r) => r.requirement_key !== 'fee') }], /^"Retainer fee paid" on case 25-12345-abc changed since this card was prepared \(it now reads nothing — no such step\)/],
    ['another step changed (the unblocked set may differ)', (s) => [s, { base: BASE().map((r) => (r.requirement_key === 'w2' ? { ...r, status: 'done' } : r)) }], /^The steps of case 25-12345-abc changed since this card was prepared, which changes what this override unblocks/],
    ['another step made required', (s) => [s, { base: BASE().map((r) => (r.requirement_key === 'courtesy' ? { ...r, required: 1 } : r)) }], /^The steps of case 25-12345-abc changed/],
    ['the pipeline changed', (s) => [s, { pipeOver: { template: { id: 3 } } }], /^The pipeline or stage of case 25-12345-abc changed since this card was prepared/],
    ['the case moved', (s) => [s, { pipeOver: { current: { stage_key: 'docs' } } }], /^The pipeline or stage of case 25-12345-abc changed/],
    ['A → B → A (one more history row)', (s) => [s, { pipeOver: { history: [{}, {}] } }], /^The pipeline or stage of case 25-12345-abc changed/],
    ['the step\'s stage renumbered', (s) => [s, { pipeOver: { stages: [{ stage_id: 21, stage_key: 'retained', stage_number: 4 }] } }], /^The stage of "Retainer fee paid" on case 25-12345-abc's pipeline changed/],
    ['the phase changed', (s) => [s, { caseOver: { pipeline_phase: 'intake' } }], /^The phase, type or subtype of case 25-12345-abc changed/],
    ['the subtype changed', (s) => [s, { caseOver: { case_subtype: 'Chapter 13' } }], /^The phase, type or subtype of case 25-12345-abc changed/],
  ])('refuses on any difference: %s', async (_name, pick, re) => {
    const [card, opts] = pick(setCard, clearCard);
    await expect(browser(reads(opts).api).caseOverridePrecheck(card)).resolves.toMatch(re);
  });

  test('a case gone (404 on any read) is "no longer exists"; another read failure throws (the card stays retryable)', async () => {
    const gone = jest.fn(async () => { throw Object.assign(new Error('Case 7KQ2M9XA not found'), { status: 404 }); });
    await expect(browser(gone).caseOverridePrecheck(setCard)).resolves.toBe('Case 25-12345-abc no longer exists. Nothing was written.');
    const down = jest.fn(async () => { throw Object.assign(new Error('boom'), { status: 500 }); });
    await expect(browser(down).caseOverridePrecheck(setCard)).rejects.toThrow('boom');
  });

  test('the result checks read the routes\' own payloads', () => {
    const b = browser(jest.fn());
    const okSet = { status: 'success', override: { case_id: CASE_ID, requirement_key: 'fee', status: 'na', note: 'Paid in cash at the consult' } };
    expect(b.caseOverrideResult(setCard, okSet)).toEqual({ case_id: CASE_ID });
    for (const bad of [{ ...okSet, status: 'error' }, { status: 'success' }, { status: 'success', override: { ...okSet.override, status: 'done' } },
      { status: 'success', override: { ...okSet.override, note: 'Paid in cash' } }, { status: 'success', override: { ...okSet.override, requirement_key: 'w2' } },
      { status: 'success', override: { ...okSet.override, case_id: 'OTHER123' } }]) {
      expect(() => b.caseOverrideResult(setCard, bad)).toThrow();
    }
    const okClear = { status: 'success', cleared: true, case_id: CASE_ID, requirement_key: 'fee' };
    expect(b.caseOverrideResult(clearCard, okClear)).toEqual({ case_id: CASE_ID });
    for (const bad of [{ ...okClear, cleared: false }, { ...okClear, requirement_key: 'w2' }, { ...okClear, case_id: 'OTHER123' }, { status: 'success', override: okSet.override }]) {
      expect(() => b.caseOverrideResult(clearCard, bad)).toThrow();
    }
  });

  test('outcomes: the clear route\'s "no override" 404 is a refusal; anything else falls through to the shared rules', () => {
    const b = browser(jest.fn());
    expect(b.caseOverrideKnownOutcome({ status: 404, message: 'No override on requirement "fee" for case 7KQ2M9XA' }))
      .toEqual({ status: 'Refused — nothing written', text: expect.stringMatching(/^Refused — nothing written: the step had no override left when this was applied \(someone cleared it first\)/) });
    expect(b.caseOverrideKnownOutcome({ status: 404, message: 'Case 7KQ2M9XA not found' })).toBe(null);
    expect(b.caseOverrideKnownOutcome({ status: 400, message: 'Unknown requirement key "fee"' })).toBe(null);
    expect(b.caseOverrideKnownOutcome({ status: 404, message: 'No override on requirement "fee"', body: { idempotency: {} } })).toBe(null);
  });

  test('DANGER: a REQUIRED step marked done / N/A the system does not see done, or a clear that reopens one — on the family the engine calls', () => {
    const { family } = browser(jest.fn());
    expect([family.id, family.danger === undefined]).toEqual(['case_requirement_override', false]);
    expect(family.danger(setCard)).toBe(true);
    expect(family.danger(clearCard)).toBe(true);
    const row = (o) => ({ required: 1, derived_status: 'active', after_status: 'na', ...o });
    expect(family.danger({ kind: 'case.requirement.override.v1', rows: [row({ required: 0 })] })).toBe(false);
    expect(family.danger({ kind: 'case.requirement.override.v1', rows: [row({ derived_status: 'done' })] })).toBe(false);
    expect(family.danger({ kind: 'case.requirement.override.v1', rows: [row({ derived_status: 'skipped' })] })).toBe(true);
    expect(family.danger({ kind: 'case.requirement.override.v1', rows: [row({ derived_status: 'done' }), row({ derived_status: 'upcoming' })] })).toBe(true);
    expect(family.danger({ kind: 'case.requirement.override.clear.v1', rows: [row({ after_status: 'upcoming' })] })).toBe(true);
    expect(family.danger({ kind: 'case.requirement.override.clear.v1', rows: [row({ after_status: 'done' })] })).toBe(false);
    expect(family.danger({ kind: 'case.requirement.override.clear.v1', rows: [row({ after_status: 'skipped' })] })).toBe(false);
    expect(family.danger({ kind: 'case.requirement.override.clear.v1', rows: [row({ required: 0, after_status: 'active' })] })).toBe(false);
    // A note-only set (status before = after) moves nothing: never danger, even on a REQUIRED step the system does not see done.
    expect(family.danger({ kind: 'case.requirement.override.v1', note_only: true, rows: [row({ status: 'na', after_status: 'na' })] })).toBe(false);
    expect(family.danger({ kind: 'case.requirement.override.v1', rows: [row({ status: 'done', after_status: 'na' })] })).toBe(true);
  });

  test('the card text names the step, both statuses, the reason, the moves and the log line', () => {
    const b = browser(jest.fn());
    const t = b.caseOverrideText(setCard);
    for (const line of ['Action: Mark step N/A', 'Step: "Retainer fee paid" (fee) — REQUIRED', 'At: stage Retained (retained) on Chapter 7 — reads active now; after: N/A',
      'Override: N/A', 'Reason (note): "Paid in cash at the consult"', 'Moves Casey\'s pipeline cards gate: unblocks Docs requested (docs) — its next stage',
      'Case log: "Requirement fee: marked N/A (override) - Paid in cash at the consult"', 'Stage: unchanged — this card never moves the case; a move is its own card.']) {
      expect(t.split('\n')).toContain(line);
    }
    const nt = b.caseOverrideText({ ...setCard, note_only: true, note: 'new reason', existing: { status: 'na', note: 'old reason', set_by_text: 'Fred (user #6)', at_text: 'x' } });
    expect(nt.split('\n')).toContain('Override: N/A — NOTE ONLY: status unchanged (N/A); note replaced: "old reason" → "new reason"');
    const ct = b.caseOverrideText(clearCard);
    expect(ct.split('\n')).toEqual(expect.arrayContaining(['Action: Clear step override', 'Reason (note): none — a clear takes no note',
      'Override it drops: done, set by Fred (user #6) on 2026-11-01 09:30 firm time, note "paid"', 'Moves Casey\'s pipeline cards gate: re-blocks Docs requested (docs) — its next stage']));
  });
});
