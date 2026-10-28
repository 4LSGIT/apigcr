'use strict';
/**
 * tests/caseySequenceEnroll.test.js
 *
 * A18.4b — Casey enrolls ONE contact in ONE sequence template's PUBLISHED
 * version through a reviewed card (kind sequence.enroll.v1), over the
 * A18.4a-hardened POST /sequences/enroll.
 *
 * The contract pinned here:
 *   1. the card's step preview comes from the ENGINE (previewEnrollmentSteps,
 *      POST /sequences/preview's seam) with version 'published' — a template
 *      with an unpublished draft previews the version an enroll RUNS, never
 *      the draft; the engine option itself is additive and fail-closed;
 *   2. refusals: the casey_sequence_enroll_enabled switch (on unless '0'),
 *      every enrollment-data key BY NAME, template_type BY NAME, unknown keys,
 *      evidence missing either id, a missing / never-published / inactive /
 *      empty / unreviewed-type template, a missing contact, an existing active
 *      contact-scoped enrollment (named), and a first-placement walk that hits
 *      a timing error (the enroll would fail SCHEDULING_FAILED);
 *   3. a LATER step's timing error and a placeholder delay.at are disclosed,
 *      not refused; unresolved placeholders are listed per step;
 *   4. the SHIPPED browser builder can express nothing but
 *      POST /sequences/enroll {contact_id, template_id, trigger_data:{}};
 *   5. the click-time precheck and the coded-outcome table (knownOutcome).
 * The duplicate predicate and the preview over real rows run on a real
 * engine in tests/caseySequenceEnroll.mysql.test.js.
 *
 *   npx jest tests/caseySequenceEnroll.test.js
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const engine = require(path.join(REPO, 'lib', 'sequenceEngine'));
const { normalizeActionDraft } = require(path.join(REPO, 'services', 'assistantService'));

// Template 12: active, published v3 (sms → task → email) with an unpublished
// draft v4 whose single step must never reach the card.
const TPL = { id: 12, name: 'Lead Drip', type: 'lead', active: 1, current_version: 3, draft_version: 4 };
const sms = (n, timing = { type: 'immediate' }, params = {}) => ({ id: 100 + n, template_id: 12, version: 3, step_number: n, action_type: 'sms',
  action_config: JSON.stringify({ function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi {{contacts.contact_fname}}', ...params } }),
  timing: JSON.stringify(timing), condition: null, fire_guard: null, error_policy: null });
const task = (n) => ({ id: 100 + n, template_id: 12, version: 3, step_number: n, action_type: 'task',
  action_config: JSON.stringify({ function_name: 'create_task', params: { title: 'Call back', assigned_to: 7 } }),
  timing: JSON.stringify({ type: 'delay', value: 2, unit: 'days' }), condition: null, fire_guard: null, error_policy: null });
const email = (n, timing = { type: 'delay', value: 1, unit: 'hours' }) => ({ id: 100 + n, template_id: 12, version: 3, step_number: n, action_type: 'email',
  action_config: JSON.stringify({ function_name: 'send_email', params: { from: 'office@4lsg.com', to: '{{contacts.contact_email}}', subject: 'Welcome', text: 'Dear {{contacts.contact_fname}}' } }),
  timing: JSON.stringify(timing), condition: null, fire_guard: null, error_policy: null });
const PUBLISHED = [sms(1), task(2), email(3)];
const DRAFT = [{ ...sms(1, { type: 'immediate' }, { message: 'DRAFT TEXT' }), version: 4 }];

function makeDb(over = {}) {
  const state = {
    tpl: { ...TPL, ...(over.tpl || {}) },
    published: (over.published || PUBLISHED).map((s) => ({ ...s })),
    contact: over.contact === undefined ? { contact_id: 77, contact_name: 'Dana Client' } : over.contact,
    existing: over.existing || [],
    reads: [],
  };
  const query = jest.fn(async (sql, params = []) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    state.reads.push([flat, params]);
    if (/^SELECT id, name, type, active, current_version, draft_version FROM sequence_templates WHERE id = \?$/.test(flat)) {
      return [params[0] === state.tpl.id ? [{ ...state.tpl }] : []];
    }
    // previewEnrollmentSteps' own template read
    if (/^SELECT id, name, type, current_version, draft_version FROM sequence_templates WHERE id = \?$/.test(flat)) {
      return [params[0] === state.tpl.id ? [{ ...state.tpl }] : []];
    }
    if (/^SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \? ORDER BY step_number ASC$/.test(flat)) {
      if (params[1] === state.tpl.current_version) return [state.published.map((s) => ({ ...s }))];
      if (params[1] === state.tpl.draft_version) return [DRAFT.map((s) => ({ ...s }))];
      return [[]];
    }
    if (/^SELECT template_condition FROM sequence_template_versions WHERE template_id = \? AND version = \?$/.test(flat)) return [[]];
    if (/^SELECT contact_id, contact_name FROM contacts WHERE contact_id = \? LIMIT 1$/.test(flat)) {
      return [state.contact && params[0] === state.contact.contact_id ? [{ ...state.contact }] : []];
    }
    // resolverService over the contacts anchor
    if (/FROM `contacts` WHERE `contacts`.`contact_id` = \? LIMIT 1$/.test(flat)) {
      return [[{ contacts__contact_id: 77, contacts__contact_fname: 'Dana', contacts__contact_phone: '3135551234', contacts__contact_email: 'dana@example.com' }]];
    }
    if (/^SELECT id FROM sequence_enrollments WHERE contact_id = \? AND template_id = \? AND \(appt_id <=> \?\) AND \(signing_request_id <=> \?\) AND status = 'active' LIMIT 1$/.test(flat)) {
      return [state.existing.map((id) => ({ id }))];
    }
    if (/^SELECT COUNT\(\*\) AS n FROM sequence_enrollments WHERE template_id = \? AND status = 'active'$/.test(flat)) return [[{ n: 4 }]];
    if (/^SELECT id, type FROM sequence_templates WHERE id = \?$/.test(flat)) return [[{ id: state.tpl.id, type: state.tpl.type }]];
    // automationReadService.sequenceReferences
    if (/FROM hook_targets ht JOIN hooks h/.test(flat)) {
      return [[{ target_id: 9, target_name: 'enroll', target_active: 1, config: JSON.stringify({ template_id: 12 }), hook_id: 5, hook_name: 'Lead hook' }]];
    }
    if (/FROM trigger_rule_actions a JOIN trigger_rules tr/.test(flat)) return [[]];
    if (/FROM workflow_steps s JOIN workflows w/.test(flat)) return [[]];
    if (/FROM cta_links/.test(flat)) return [[]];
    if (/FROM (?:email|phone)_ingest_rule_actions a JOIN/.test(flat)) return [[]];
    throw new Error(`unscripted query: ${flat}`);
  });
  return { state, db: { query } };
}

const EVIDENCE = [
  { id: 'q1', label: 'Sequence 12 definition', rows: [{ sequence_template_id: 12, step_number: 1 }] },
  { id: 'q2', label: 'Contact', rows: [{ contact_id: 77, contact_name: 'Dana Client' }] },
];
const REFS = [{ query_id: 'q1', row_number: 1 }, { query_id: 'q2', row_number: 1 }];
const enrollDraft = (over = {}) => ({ kind: 'sequence.enroll.v1', sequence_template_id: 12, contact_id: 77, evidence: REFS, ...over });

beforeEach(() => { process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '1'; });
afterEach(() => { delete process.env.CASEY_SEQUENCE_ENROLL_ENABLED; jest.restoreAllMocks(); });

describe('the sequence-enroll normalizer', () => {
  test('a valid enroll normalizes into the engine preview of the PUBLISHED version', async () => {
    const spy = jest.spyOn(engine, 'previewEnrollmentSteps');
    const { db, state } = makeDb();
    const out = await normalizeActionDraft(db, enrollDraft(), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'sequence.enroll.v1', status: 'draft',
      template: { sequence_template_id: 12, name: 'Lead Drip', type: 'lead', version: 3, step_count: 3, has_draft: 1 },
      contact: { contact_id: 77, contact_name: 'Dana Client' },
      verdict: 'would_proceed', first_step: 1, skipped_leading: [], stall_step: null, placeholder_at_steps: [],
      send_steps: 2, steps_truncated: 0, active_enrollments: 4,
      starters: [{ source: 'hook', name: 'Lead hook', active: 1 }],
      expected: { current_version: 3 },
      evidence: [expect.objectContaining({ query_id: 'q1', row_number: 1 }), expect.objectContaining({ query_id: 'q2', row_number: 1 })],
    });
    expect(out.draft_id).toMatch(/^[0-9a-f-]{36}$/);
    // The engine seam, called with the published option and empty trigger data.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ template_id: 12, contact_id: 77, trigger_data: {}, version: 'published' });
    // Only the published version's steps are read — the draft (v4) never is.
    const stepReads = state.reads.filter(([sql]) => /FROM sequence_steps WHERE template_id/.test(sql));
    expect(stepReads.map(([, p]) => p)).toEqual([[12, 3], [12, 3]]);
    expect(JSON.stringify(out)).not.toContain('DRAFT TEXT');
    // Per-step preview: resolved for THIS contact, timing in plain words.
    expect(out.steps).toHaveLength(3);
    expect(out.steps[0]).toMatchObject({ step_number: 1, action_type: 'sms', function_name: 'send_sms', sends: true, placement: 'places',
      to: '3135551234', from: '2484179800', message: 'Hi Dana' });
    expect(out.steps[0].timing_text).toMatch(/^Immediately/);
    expect(out.steps[0].when_text).toMatch(/firm time$/);
    expect(out.steps[1]).toMatchObject({ step_number: 2, action_type: 'task', function_name: 'create_task', sends: false, placement: 'places' });
    expect(out.steps[1].timing_text).toBe('2 days after the previous step (or after enrollment for step 1)');
    expect(out.steps[2]).toMatchObject({ step_number: 3, sends: true, to: 'dana@example.com', subject: 'Welcome', body: 'Dear Dana' });
    expect(out.effects).toEqual([
      'step 1: send_sms — external-send: messages {{contacts.contact_phone}} when this enrollment reaches it',
      'step 3: send_email — external-send: messages {{contacts.contact_email}} when this enrollment reaches it',
    ]);
    // The card never carries enrollment data or a cascade selector.
    for (const key of ['trigger_data', 'template_type', 'appt_id', 'signing_request_id']) expect(out).not.toHaveProperty(key);
  });

  test('the switch is on unless "0" (one polarity for every Casey flag, Fred 2026-10-28) — "0" refuses before anything is read', async () => {
    process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '0';
    {
      const { db } = makeDb();
      await expect(normalizeActionDraft(db, enrollDraft(), EVIDENCE)).rejects.toThrow(/^Action kind is unavailable$/);
      expect(db.query).not.toHaveBeenCalled();
    }
    // Any other value — unset and blank included — leaves the kind live.
    for (const v of [undefined, '', '1', 'true']) {
      if (v === undefined) delete process.env.CASEY_SEQUENCE_ENROLL_ENABLED; else process.env.CASEY_SEQUENCE_ENROLL_ENABLED = v;
      await expect(normalizeActionDraft(makeDb().db, enrollDraft(), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
    }
    // The authoring flag is a different family: dark authoring leaves enroll on.
    process.env.CASEY_SEQUENCE_ENROLL_ENABLED = '1';
    process.env.CASEY_SEQUENCE_AUTHORING_ENABLED = '0';
    try {
      await expect(normalizeActionDraft(makeDb().db, enrollDraft(), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
    } finally { delete process.env.CASEY_SEQUENCE_AUTHORING_ENABLED; }
  });

  test('every enrollment-data key is refused BY NAME, before anything is read', async () => {
    for (const key of ['trigger_data', 'triggerData', 'payload', 'input', 'appt_id', 'signing_request_id', 'case_id']) {
      const { db } = makeDb();
      await expect(normalizeActionDraft(db, enrollDraft({ [key]: { appt_id: 5 } }), EVIDENCE))
        .rejects.toThrow(new RegExp(`^Sequence enroll takes no enrollment data \\(${key}\\) — Casey enrolls a contact with empty trigger data`));
      expect(db.query).not.toHaveBeenCalled();
    }
    const { db } = makeDb();
    await expect(normalizeActionDraft(db, enrollDraft({ template_type: 'lead' }), EVIDENCE))
      .rejects.toThrow(/never picks a template by type \(template_type\)/);
    await expect(normalizeActionDraft(db, enrollDraft({ version: 4 }), EVIDENCE))
      .rejects.toThrow(/^Sequence enroll carries unsupported fields: version — it takes sequence_template_id, contact_id and evidence only$/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('ids must be positive integers', async () => {
    const { db } = makeDb();
    await expect(normalizeActionDraft(db, enrollDraft({ sequence_template_id: '12x' }), EVIDENCE)).rejects.toThrow(/positive sequence_template_id/);
    await expect(normalizeActionDraft(db, enrollDraft({ contact_id: 0 }), EVIDENCE)).rejects.toThrow(/positive contact_id/);
  });

  test('evidence must carry BOTH the exact template id and the exact contact id', async () => {
    const { db } = makeDb();
    await expect(normalizeActionDraft(db, enrollDraft({ evidence: [] }), EVIDENCE)).rejects.toThrow(/does not identify the target template/);
    await expect(normalizeActionDraft(db, enrollDraft({ evidence: [REFS[1]] }), EVIDENCE)).rejects.toThrow(/does not identify the target template/);
    await expect(normalizeActionDraft(db, enrollDraft({ evidence: [REFS[0]] }), EVIDENCE)).rejects.toThrow(/does not identify the contact — cite a row carrying the exact contact_id/);
    const otherContact = [EVIDENCE[0], { id: 'q2', rows: [{ contact_id: 78 }] }];
    await expect(normalizeActionDraft(db, enrollDraft(), otherContact)).rejects.toThrow(/does not identify the contact/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a missing, never-published, inactive, empty or unreviewed-type template refuses', async () => {
    await expect(normalizeActionDraft(makeDb({ tpl: { id: 99 } }).db, enrollDraft(), EVIDENCE)).rejects.toThrow(/Sequence template 12 is unavailable/);
    await expect(normalizeActionDraft(makeDb({ tpl: { current_version: 0 } }).db, enrollDraft(), EVIDENCE)).rejects.toThrow(/never been published — an enroll would be refused \(NEVER_PUBLISHED\)/);
    await expect(normalizeActionDraft(makeDb({ tpl: { active: 0 } }).db, enrollDraft(), EVIDENCE)).rejects.toThrow(/is inactive — the enroll route refuses it/);
    await expect(normalizeActionDraft(makeDb({ published: [] }).db, enrollDraft(), EVIDENCE)).rejects.toThrow(/has no steps — an enroll would be refused \(EMPTY_SEQUENCE\)/);
    const odd = { ...task(2), action_type: 'custom_code' };
    await expect(normalizeActionDraft(makeDb({ published: [sms(1), odd] }).db, enrollDraft(), EVIDENCE))
      .rejects.toThrow(/has step 2 \(custom_code\) of a type Casey's enroll card does not cover/);
  });

  test('a missing contact refuses', async () => {
    await expect(normalizeActionDraft(makeDb({ contact: null }).db, enrollDraft(), EVIDENCE)).rejects.toThrow(/^Contact 77 is unavailable$/);
  });

  test('an active contact-scoped enrollment refuses the card, named — with the engine\'s own predicate', async () => {
    const spy = jest.spyOn(engine, 'previewEnrollmentSteps');
    const { db, state } = makeDb({ existing: [5501] });
    await expect(normalizeActionDraft(db, enrollDraft(), EVIDENCE))
      .rejects.toThrow(/^Dana Client \(contact 77\) is already enrolled in "Lead Drip" — active enrollment #5501; nothing is proposed \(an enroll would be refused ALREADY_ENROLLED\)$/);
    const dup = state.reads.find(([sql]) => /FROM sequence_enrollments WHERE contact_id/.test(sql));
    expect(dup[1]).toEqual([77, 12, null, null]);
    expect(spy).not.toHaveBeenCalled();
  });

  test('a timing error before any step places refuses — the enroll itself would fail SCHEDULING_FAILED', async () => {
    const cases = [
      [{ type: 'before_appt', hoursBack: 24 }],
      [{ type: 'delay', at: '{{trigger_data.court_date}}' }],
    ];
    for (const [timing] of cases) {
      const { db } = makeDb({ published: [sms(1, timing), task(2)] });
      await expect(normalizeActionDraft(db, enrollDraft(), EVIDENCE))
        .rejects.toThrow(/^Sequence template 12: step 1's timing cannot be computed for an enrollment with no trigger data \(.+\) — the enroll would FAIL \(SCHEDULING_FAILED\)/);
    }
  });

  test('a LATER timing error is disclosed as a stall, and a placeholder delay.at is named — not refused', async () => {
    const { db } = makeDb({ published: [sms(1), email(2, { type: 'delay', at: '{{trigger_data.court_date}}' }), task(3)] });
    const out = await normalizeActionDraft(db, enrollDraft(), EVIDENCE);
    expect(out).toMatchObject({ first_step: 1, stall_step: 2, placeholder_at_steps: [2] });
    expect(out.steps[1].placement).toBe('timing_error');
    expect(out.steps[1].timing_error).toMatch(/delay\.at resolved to empty/);
    expect(out.steps[1].timing_text).toBe('stored timing {"type":"delay","at":"{{trigger_data.court_date}}"}');
  });

  test('a placeholder nothing can resolve without trigger data is listed on its step', async () => {
    const { db } = makeDb({ published: [sms(1, { type: 'immediate' }, { from: '{{users.default_phone}}', message: 'Court on {{trigger_data.court_date}}' })] });
    const out = await normalizeActionDraft(db, enrollDraft(), EVIDENCE);
    expect(out.steps[0].unresolved).toEqual(expect.arrayContaining(['{{users.default_phone}}', '{{trigger_data.court_date}}']));
    // The engine's strict:false resolution (production's own) leaves them as
    // written — the card shows exactly that, never a guessed blank.
    expect(out.steps[0]).toMatchObject({ from: '{{users.default_phone}}', message: 'Court on {{trigger_data.court_date}}' });
  });

  test('a preview that does not cover the published version refuses (fail closed)', async () => {
    jest.spyOn(engine, 'previewEnrollmentSteps').mockResolvedValue({ version: 4, steps: [{}, {}, {}] });
    await expect(normalizeActionDraft(makeDb().db, enrollDraft(), EVIDENCE)).rejects.toThrow(/preview did not cover its published version v3/);
  });
});

describe('previewEnrollmentSteps — the additive version option', () => {
  test('omitted: the editor behaviour — the draft is previewed when one exists', async () => {
    const { db } = makeDb();
    const p = await engine.previewEnrollmentSteps(db, { template_id: 12, contact_id: 77 });
    expect(p.version).toBe(4);
    expect(p.steps).toHaveLength(1);
  });
  test("'published': the version an enroll runs, even with a draft", async () => {
    const { db } = makeDb();
    const p = await engine.previewEnrollmentSteps(db, { template_id: 12, contact_id: 77, version: 'published' });
    expect(p.version).toBe(3);
    expect(p.steps.map((s) => s.step_number)).toEqual([1, 2, 3]);
  });
  test('fail closed: an unknown value, the enrollment shape, and a never-published template all throw', async () => {
    for (const version of ['draft', 'current', 3, null, true]) {
      await expect(engine.previewEnrollmentSteps(makeDb().db, { template_id: 12, contact_id: 77, version }))
        .rejects.toThrow(/unknown version option/);
    }
    await expect(engine.previewEnrollmentSteps(makeDb().db, { enrollment_id: 5, version: 'published' }))
      .rejects.toThrow(/hypothetical shape only/);
    await expect(engine.previewEnrollmentSteps(makeDb({ tpl: { current_version: 0 } }).db, { template_id: 12, contact_id: 77, version: 'published' }))
      .rejects.toThrow(/never been published — there is no published version to preview/);
  });
});

describe('the receipt', () => {
  test('the ledger records the enrollment under the same field the card\'s family reports', () => {
    const ledger = require(path.join(REPO, 'services', 'assistantActionLedger'));
    expect(ledger.KINDS.get('sequence.enroll.v1')).toBe('enrollment_id');
    const family = html.slice(html.indexOf("id: 'sequence_enroll'"), html.indexOf("id: 'hook'"));
    expect(family).toContain("idField: 'enrollment_id'");
  });
});

// ── The shipped browser builders ────────────────────────────────────────────
const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
function fnSrc(src, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!match) throw new Error(`function ${name} not found`);
  let parens = 0, body = match.index + match[0].length - 1;
  for (; body < src.length; body++) {
    if (src[body] === '(') parens++;
    else if (src[body] === ')' && --parens === 0) break;
  }
  let depth = 0;
  for (let i = body; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(match.index, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}
// eslint-disable-next-line no-new-func
const buildRequest = new Function(`${fnSrc(html, 'sequenceEnrollRequest')}; return sequenceEnrollRequest;`)();
// eslint-disable-next-line no-new-func
const knownOutcome = new Function(`${fnSrc(html, 'sequenceEnrollKnownOutcome')}; return sequenceEnrollKnownOutcome;`)();
// eslint-disable-next-line no-new-func
const makePrecheck = (api) => new Function('api', `async ${fnSrc(html, 'sequenceEnrollPrecheck')}; return sequenceEnrollPrecheck;`)(api);
// eslint-disable-next-line no-new-func
const buildResult = new Function(`${fnSrc(html, 'sequenceEnrollResult')}; return sequenceEnrollResult;`)();

describe('the fixed request builder', () => {
  test('it can express only POST /sequences/enroll {contact_id, template_id, trigger_data:{}}, whatever the draft carries', async () => {
    const card = await normalizeActionDraft(makeDb().db, enrollDraft(), EVIDENCE);
    const expected = { path: '/sequences/enroll', method: 'POST', body: { contact_id: 77, template_id: 12, trigger_data: {} }, idempotent: true };
    expect(buildRequest(card)).toEqual(expected);
    const hostile = { ...card, trigger_data: { appt_id: 5 }, template_type: 'lead', appt_id: 5,
      template: { ...card.template, template_type: 'lead' }, contact: { ...card.contact, trigger_data: { x: 1 } } };
    expect(buildRequest(hostile)).toEqual(expected);
    expect(() => buildRequest({ template: { sequence_template_id: '12;' }, contact: { contact_id: 77 } })).toThrow(/no usable template or contact/);
    expect(() => buildRequest({ template: { sequence_template_id: 12 }, contact: {} })).toThrow(/no usable template or contact/);
  });

  test('the result needs success and a usable enrollmentId', () => {
    expect(buildResult({}, { success: true, enrollmentId: 812, firstJobScheduledAt: '2026-10-28T15:00:05.000Z', totalSteps: 3 }))
      .toEqual({ enrollment_id: 812, first_job_scheduled_at: '2026-10-28T15:00:05.000Z' });
    expect(buildResult({}, { success: true, enrollmentId: 812, firstJobScheduledAt: null })).toEqual({ enrollment_id: 812, first_job_scheduled_at: null });
    expect(() => buildResult({}, { success: false, enrollmentId: 812 })).toThrow(/no usable enrollment id/);
    expect(() => buildResult({}, { success: true })).toThrow(/no usable enrollment id/);
  });
});

describe('the coded-outcome table (A18.4a ENROLL_CODE_STATUS)', () => {
  const err = (status, body, message = 'msg') => Object.assign(new Error(message), { status, body });
  test('each coded refusal is a refusal, SCHEDULING_FAILED is a known failure naming the cancelled row', () => {
    expect(knownOutcome(err(409, { code: 'ALREADY_ENROLLED', enrollment_id: 5501 }))).toEqual({ status: 'Refused — nothing enrolled',
      text: 'Refused — nothing enrolled: the contact is already enrolled in this sequence (active enrollment #5501).' });
    for (const code of ['NEVER_PUBLISHED', 'EMPTY_SEQUENCE']) {
      expect(knownOutcome(err(409, { code }, 'boom'))).toEqual({ status: 'Refused — nothing enrolled',
        text: 'Refused — nothing enrolled (boom): the template changed since this card was reviewed. Ask Casey to prepare the enrollment again.' });
    }
    expect(knownOutcome(err(503, { code: 'ENROLL_BUSY' }))).toMatchObject({ status: 'Refused — nothing enrolled',
      text: expect.stringMatching(/^Refused — nothing enrolled: another enrollment .* was in progress .* Wait a moment, then ask Casey to prepare it again\.$/) });
    expect(knownOutcome(err(500, { code: 'SCHEDULING_FAILED', enrollment_id: 812 }, 'first step could not be scheduled'))).toEqual({
      status: 'Failed — nothing will send',
      text: 'Failed — enrollment #812 was created, but its first step could not be scheduled, so no step is scheduled and nothing will send (first step could not be scheduled). Fix the sequence\'s timing in the sequence editor before enrolling again.' });
  });
  test('an idempotency body, an uncoded status and a mismatched status/code pair all fall through (null)', () => {
    expect(knownOutcome(err(409, { code: 'ALREADY_ENROLLED', idempotency: { outcome: 'in_flight' } }))).toBeNull();
    expect(knownOutcome(err(409, { idempotency: { outcome: 'in_flight' } }))).toBeNull();
    expect(knownOutcome(err(409, { error: 'x' }))).toBeNull();
    expect(knownOutcome(err(500, { error: 'Failed to enroll contact' }))).toBeNull();
    expect(knownOutcome(err(503, {}))).toBeNull();
    expect(knownOutcome(err(500, { code: 'ENROLL_BUSY' }))).toBeNull();
    expect(knownOutcome(err(409, { code: 'SCHEDULING_FAILED' }))).toBeNull();
    expect(knownOutcome(new Error('Failed to fetch'))).toBeNull();
  });
});

describe('the click-time precheck', () => {
  const draft = { template: { sequence_template_id: 12 }, contact: { contact_id: 77, contact_name: 'Dana Client' }, expected: { current_version: 3 } };
  const reads = ({ tpl = { id: 12, active: 1, current_version: 3 }, rows = [], total } = {}) => jest.fn(async (path) => {
    if (path === '/sequences/templates/12') return tpl ? { success: true, template: tpl, steps: [] } : { success: true };
    if (path === '/sequences/enrollments?contact_id=77&status=active&limit=100') {
      return { success: true, enrollments: rows, pagination: { total: total == null ? rows.length : total } };
    }
    throw new Error(`unexpected read ${path}`);
  });
  test('a clean re-read passes; it reads only the template and the contact\'s active enrollments', async () => {
    const api = reads({ rows: [{ id: 1, contact_id: 77, template_id: 12, appt_id: 900, signing_request_id: null, status: 'active' },
      { id: 2, contact_id: 77, template_id: 13, appt_id: null, signing_request_id: null, status: 'active' }] });
    await expect(makePrecheck(api)(draft)).resolves.toBe('');
    expect(api.mock.calls.map((c) => c[0])).toEqual(['/sequences/templates/12', '/sequences/enrollments?contact_id=77&status=active&limit=100']);
  });
  test('gone, deactivated, a new published version, or already enrolled refuses', async () => {
    await expect(makePrecheck(reads({ tpl: null }))(draft)).resolves.toBe('The sequence template no longer exists. Nothing was enrolled.');
    await expect(makePrecheck(reads({ tpl: { id: 12, active: 0, current_version: 3 } }))(draft)).resolves.toMatch(/deactivated .* Nothing was enrolled\.$/);
    await expect(makePrecheck(reads({ tpl: { id: 12, active: 1, current_version: 4 } }))(draft)).resolves.toMatch(/^The template's published version changed \(v3 → v4\)/);
    await expect(makePrecheck(reads({ rows: [{ id: 5501, contact_id: 77, template_id: 12, appt_id: null, signing_request_id: null, status: 'active' }] }))(draft))
      .resolves.toBe('Dana Client is already enrolled in this sequence (active enrollment #5501). Nothing was enrolled.');
  });
  test('an enrollment list it cannot read in full throws (the card stays retryable, nothing claimed)', async () => {
    await expect(makePrecheck(reads({ rows: [], total: 101 }))(draft)).rejects.toThrow(/could not be read in full/);
  });
});
