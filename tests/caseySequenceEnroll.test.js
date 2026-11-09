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
 *      the other trigger-data spellings and the top-level ids BY NAME,
 *      template_type BY NAME, unknown keys,
 *      evidence missing either id, a missing / never-published / inactive /
 *      empty / unreviewed-type template, a missing contact, an existing active
 *      contact-scoped enrollment (named), and a first-placement walk that hits
 *      a timing error (the enroll would fail SCHEDULING_FAILED);
 *   3. a LATER step's timing error and a placeholder delay.at are disclosed,
 *      not refused; unresolved placeholders are listed per step;
 *   4. the SHIPPED browser builder can express nothing but
 *      POST /sequences/enroll {contact_id, template_id, trigger_data:{}} —
 *      unless the server-computed `payload` is present (A18.4c, below);
 *   5. the click-time precheck and the coded-outcome table (knownOutcome);
 *   6. A18.4c — the reviewed trigger_data: the no-payload enroll pinned
 *      byte-for-byte, the closed key set, scalar values, the refused names,
 *      evidence-bound ids consistent with the contact (case_id, appt_id and
 *      the appointment's own time / provider / case), the appointment scope
 *      in the duplicate predicate, the walk WITH the payload, the capture
 *      disclosure, and the builder sending the payload exactly as reviewed.
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
// A18.4c fixtures: appointment 900 is Dana's (provider 3, case CASE1, 40
// days out at 14:00 firm time — relative, so the fixture never rots into the
// past); 901 is another contact's.
const { DateTime } = require('luxon');
const APPT_AT = DateTime.now().setZone('America/Detroit').plus({ days: 40 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 });
const APPT_LOCAL = APPT_AT.toFormat('yyyy-MM-dd HH:mm:ss');
const APPT_UTC = APPT_AT.toUTC().toJSDate().toISOString();
const APPTS = {
  900: { appt_id: 900, appt_client_id: 77, appt_case_id: 'CASE1', appt_type: '341 Meeting', appt_status: 'Scheduled', appt_with: 3, appt_local: APPT_LOCAL, user_name: 'Stuart' },
  901: { appt_id: 901, appt_client_id: 78, appt_case_id: '', appt_type: 'Consult', appt_status: 'Scheduled', appt_with: 3, appt_local: APPT_LOCAL, user_name: 'Stuart' },
};
const CASES = {
  CASE1: { case_id: 'CASE1', label: '26-12345', case_caption: 'In re Client', relates: { 77: 'Primary' } },
  CASE2: { case_id: 'CASE2', label: '26-99999', case_caption: 'In re Other', relates: { 78: 'Primary' } },
};
const DRAFT = [{ ...sms(1, { type: 'immediate' }, { message: 'DRAFT TEXT' }), version: 4 }];

function makeDb(over = {}) {
  const state = {
    tpl: { ...TPL, ...(over.tpl || {}) },
    published: (over.published || PUBLISHED).map((s) => ({ ...s })),
    contact: over.contact === undefined ? { contact_id: 77, contact_name: 'Dana Client' } : over.contact,
    existing: over.existing || [],
    // A18.4c: [contact_id, appt_id] pairs of active rows, for the scoped predicate.
    existingScoped: over.existingScoped || null,
    reads: [],
  };
  const others = { 78: 'Other Person', ...(over.others || {}) };
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
    if (/^SELECT template_condition FROM sequence_template_versions WHERE template_id = \? AND version = \?$/.test(flat)) {
      return [over.cond ? [{ template_condition: JSON.stringify(over.cond) }] : []];
    }
    if (/^SELECT contact_id, contact_name FROM contacts WHERE contact_id = \? LIMIT 1$/.test(flat)) {
      if (state.contact && params[0] === state.contact.contact_id) return [[{ ...state.contact }]];
      return [others[params[0]] ? [{ contact_id: params[0], contact_name: others[params[0]] }] : []];
    }
    // A18.4c: the capture arm (every enroll), the samples (payload only).
    if (/^SELECT capture_mode FROM sequence_templates WHERE id = \?$/.test(flat)) {
      return [params[0] === state.tpl.id ? [{ capture_mode: over.capture_mode || 'off' }] : []];
    }
    if (/^SELECT test_input, captured_input FROM sequence_templates WHERE id = \?$/.test(flat)) {
      return [params[0] === state.tpl.id ? [{ test_input: null, captured_input: null, ...(over.meta || {}) }] : []];
    }
    if (/FROM appts a LEFT JOIN users u ON u.user = a.appt_with WHERE a.appt_id = \? LIMIT 1$/.test(flat)) {
      const a = (over.appts || APPTS)[params[0]];
      return [a ? [{ ...a }] : []];
    }
    if (/FROM cases c WHERE c.case_id = \? LIMIT 1$/.test(flat)) {
      const c = (over.cases || CASES)[params[1]];
      return [c ? [{ ...c, relate_type: (c.relates || {})[params[0]] || null }] : []];
    }
    // resolverService over the contacts anchor
    if (/FROM `contacts` WHERE `contacts`.`contact_id` = \? LIMIT 1$/.test(flat)) {
      return [[{ contacts__contact_id: 77, contacts__contact_fname: 'Dana', contacts__contact_phone: '3135551234', contacts__contact_email: 'dana@example.com' }]];
    }
    if (/^SELECT id FROM sequence_enrollments WHERE contact_id = \? AND template_id = \? AND \(appt_id <=> \?\) AND \(signing_request_id <=> \?\) AND status = 'active' LIMIT 1$/.test(flat)) {
      if (state.existingScoped) {
        return [state.existingScoped.filter(([id, appt]) => (appt == null ? params[2] == null : params[2] === appt)).map(([id]) => ({ id }))];
      }
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
    // A18.4e: optoutService's own reads (FIND_SQL) for the sends' recipients.
    // over.optout = { smsRows: {dest: cache_optout}, emailRows: {dest: cache_optout},
    //   states: [{channel, destination, scope, state}], versions: [{channel, destination, version}], topics: [{topic_key, channel, consent_model, active}] }
    const oo = over.optout || {};
    if (/FROM contact_phones r LEFT JOIN contacts ct/.test(flat)) {
      return [(params[0] || []).filter((k) => (oo.smsRows || {})[k] !== undefined).map((k, i) => ({ row_id: 300 + i, contact_id: 77, destination: k, contact_name: 'Dana Client', cache_optout: oo.smsRows[k] }))];
    }
    if (/FROM contact_emails r LEFT JOIN contacts ct/.test(flat)) {
      return [(params[0] || []).filter((k) => (oo.emailRows || {})[k] !== undefined).map((k, i) => ({ row_id: 400 + i, contact_id: 77, destination: k, contact_name: 'Dana Client', cache_optout: oo.emailRows[k] }))];
    }
    if (/^SELECT destination, scope, state FROM comm_consent_state WHERE channel = \? AND destination IN \(\?\) AND scope IN \(\?\)$/.test(flat)) {
      return [(oo.states || []).filter((s) => s.channel === params[0] && params[1].includes(s.destination) && params[2].includes(s.scope)).map(({ channel, ...s }) => s)];
    }
    if (/^SELECT destination, MAX\(last_event_id\) AS version FROM comm_consent_state WHERE channel = \? AND destination IN \(\?\) GROUP BY destination$/.test(flat)) {
      return [(oo.versions || []).filter((v) => v.channel === params[0] && params[1].includes(v.destination)).map(({ channel, ...v }) => v)];
    }
    if (/^SELECT channel, consent_model, active FROM comm_topics WHERE topic_key = \?$/.test(flat)) {
      return [(oo.topics || []).filter((t) => t.topic_key === params[0]).map(({ topic_key, ...t }) => t)];
    }
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

  // A18.4c moved this pin: trigger_data is no longer refused by name (an
  // unknown trigger_data key and a non-scalar value are — A18.4c below); the
  // other spellings and the TOP-LEVEL ids still are.
  test('the other trigger-data spellings and the top-level ids are refused BY NAME, before anything is read', async () => {
    for (const key of ['triggerData', 'payload', 'input', 'appt_id', 'signing_request_id', 'case_id']) {
      const { db } = makeDb();
      await expect(normalizeActionDraft(db, enrollDraft({ [key]: { appt_id: 5 } }), EVIDENCE))
        .rejects.toThrow(new RegExp(`^Sequence enroll takes its enrollment data as trigger_data only \\(${key}\\) — one spelling, and appt_id / case_id ride INSIDE trigger_data`));
      expect(db.query).not.toHaveBeenCalled();
    }
    const { db } = makeDb();
    await expect(normalizeActionDraft(db, enrollDraft({ template_type: 'lead' }), EVIDENCE))
      .rejects.toThrow(/never picks a template by type \(template_type\)/);
    await expect(normalizeActionDraft(db, enrollDraft({ version: 4 }), EVIDENCE))
      .rejects.toThrow(/^Sequence enroll carries unsupported fields: version — it takes sequence_template_id, contact_id, trigger_data and evidence only$/);
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
// A18.4c: the builder calls sequenceEnrollTriggerBody and the precheck
// sequenceEnrollApptScope — a lifted function brings what it calls.
const buildRequest = new Function(`${fnSrc(html, 'sequenceEnrollTriggerBody')}; ${fnSrc(html, 'sequenceEnrollRequest')}; return sequenceEnrollRequest;`)();
// eslint-disable-next-line no-new-func
const knownOutcome = new Function(`${fnSrc(html, 'sequenceEnrollKnownOutcome')}; return sequenceEnrollKnownOutcome;`)();
// eslint-disable-next-line no-new-func
const makePrecheck = (api) => new Function('api', `${fnSrc(html, 'sequenceEnrollApptScope')}; async ${fnSrc(html, 'sequenceEnrollPrecheck')}; return sequenceEnrollPrecheck;`)(api);
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

// ── A18.4c: the reviewed trigger_data ───────────────────────────────────────
const EVIDENCE_X = [...EVIDENCE,
  { id: 'q3', label: 'Appointments', rows: [{ appt_id: 900, appt_client_id: 77 }, { appt_id: 901, appt_client_id: 78 }] },
  { id: 'q4', label: 'Cases', rows: [{ case_id: 'CASE1' }, { case_id: 'CASE2' }] }];
const REFS_X = [...REFS, { query_id: 'q3', row_number: 1 }, { query_id: 'q3', row_number: 2 }, { query_id: 'q4', row_number: 1 }, { query_id: 'q4', row_number: 2 }];
const xDraft = (trigger_data, over = {}) => enrollDraft({ evidence: REFS_X, trigger_data, ...over });
// A18.4e added optout_steps (and expected.consent) to the shipped envelope — a deliberate widening, pinned here.
const SHIPPED_ENROLL_KEYS = ['draft_id', 'kind', 'status', 'template', 'contact', 'verdict', 'first_step', 'skipped_leading', 'stall_step',
  'placeholder_at_steps', 'send_steps', 'optout_steps', 'steps', 'steps_truncated', 'effects', 'starters', 'active_enrollments', 'expected', 'evidence'];
// Step 1 reads {{trigger_data.court_date}} as its date and in its text.
const dated = (over = {}) => [sms(1, { type: 'delay', at: '{{trigger_data.court_date}}' }, { message: 'Court on {{trigger_data.court_date}} in {{trigger_data.room}}' }), task(2), ...(over.more || [])];
const FUTURE = '2027-01-15T15:00:00Z';

describe('A18.4e — the sends\' recipients\' consent is on the card, as the step\'s own send will read it', () => {
  const SMS = { step_number: 1, channel: 'sms', destination: '3135551234' };
  const EMAIL = { step_number: 3, channel: 'email', destination: 'dana@example.com' };

  test('with nothing opted out: every send step carries consent (not opted out, version 0), the task step none; expected.consent lists them for the click re-read', async () => {
    const out = await normalizeActionDraft(makeDb().db, enrollDraft(), EVIDENCE);
    expect(out.steps[0].consent).toEqual({ ...SMS, opted_out: false, version: '0' });
    expect(out.steps[1]).not.toHaveProperty('consent');
    expect(out.steps[2].consent).toEqual({ ...EMAIL, opted_out: false, version: '0' });
    expect(out.optout_steps).toEqual([]);
    expect(out.expected).toEqual({ current_version: 3, consent: [{ ...SMS, opted_out: false, version: '0' }, { ...EMAIL, opted_out: false, version: '0' }] });
  });

  test('an SMS STOP — the ledger state or the row cache alone (optoutService\'s dual read) — flags the text step as SKIPPED-at-fire, with the consent version the click compares', async () => {
    const byState = { states: [{ channel: 'sms', destination: '3135551234', scope: 'all', state: 'opted_out' }], versions: [{ channel: 'sms', destination: '3135551234', version: 41 }] };
    const out = await normalizeActionDraft(makeDb({ optout: byState }).db, enrollDraft(), EVIDENCE);
    expect(out.steps[0].consent).toEqual({ ...SMS, opted_out: true, version: '41' });
    expect(out.optout_steps).toEqual([1]);
    expect(out.expected.consent[0]).toEqual({ ...SMS, opted_out: true, version: '41' });
    // Email untouched.
    expect(out.steps[2].consent).toEqual({ ...EMAIL, opted_out: false, version: '0' });
    const byCache = { smsRows: { 3135551234: 1 } };
    const out2 = await normalizeActionDraft(makeDb({ optout: byCache }).db, enrollDraft(), EVIDENCE);
    expect(out2.steps[0].consent).toMatchObject({ opted_out: true });
    expect(out2.optout_steps).toEqual([1]);
    // Still a proposal — an opt-out is disclosed, never refused.
    expect(out2.status).toBe('draft');
  });

  test('D18: an email opt-out never flags an OPERATIONAL email step (its version still rides); a PROMOTIONAL step reads marketing consent by its topic, and one without a topic discloses the send\'s own fire-time error', async () => {
    const emailOut = { emailRows: { 'dana@example.com': 1 },
      states: [{ channel: 'email', destination: 'dana@example.com', scope: 'marketing', state: 'opted_out' }],
      versions: [{ channel: 'email', destination: 'dana@example.com', version: 7 }],
      topics: [{ topic_key: 'newsletter', channel: 'email', consent_model: 'opt_out', active: 1 }] };
    const out = await normalizeActionDraft(makeDb({ optout: emailOut }).db, enrollDraft(), EVIDENCE);
    expect(out.steps[2].consent).toEqual({ ...EMAIL, opted_out: false, version: '7' });
    expect(out.optout_steps).toEqual([]);
    const promo = (params) => ({ ...email(3), action_config: JSON.stringify({ function_name: 'send_email',
      params: { to: '{{contacts.contact_email}}', subject: 'News', html: '<p>Hi</p>', promotional: true, ...params } }) });
    const out2 = await normalizeActionDraft(makeDb({ optout: emailOut, published: [sms(1), task(2), promo({ topic: 'newsletter' })] }).db, enrollDraft(), EVIDENCE);
    expect(out2.steps[2].consent).toEqual({ ...EMAIL, klass: 'marketing', topic: 'newsletter', opted_out: true, version: '7' });
    expect(out2.optout_steps).toEqual([3]);
    // The string spelling communication.js accepts counts as promotional too.
    const out3 = await normalizeActionDraft(makeDb({ optout: emailOut, published: [sms(1), task(2), promo({ topic: 'newsletter', promotional: 'yes' })] }).db, enrollDraft(), EVIDENCE);
    expect(out3.steps[2].consent).toMatchObject({ klass: 'marketing', opted_out: true });
    const out4 = await normalizeActionDraft(makeDb({ optout: emailOut, published: [sms(1), task(2), promo({})] }).db, enrollDraft(), EVIDENCE);
    expect(out4.steps[2].consent).toEqual({ ...EMAIL, klass: 'marketing', topic: null, error: 'send_email: promotional requires topic (the consent question is asked per topic)' });
    expect(out4.optout_steps).toEqual([]);
    expect(out4.expected.consent.map((c) => c.step_number)).toEqual([1]);
  });

  test('a recipient the preview could not resolve (placeholder left, or blank) is not checked — no consent key, no read, no crash', async () => {
    const published = [sms(1, { type: 'immediate' }, { to: '{{contacts.contact_mobile}}' }), task(2), { ...email(3), action_config: JSON.stringify({ function_name: 'send_email', params: { from: 'office@4lsg.com', to: '', subject: 'x', text: 'y' } }) }];
    const { db, state } = makeDb({ published, optout: { smsRows: { 3135551234: 1 } } });
    const out = await normalizeActionDraft(db, enrollDraft(), EVIDENCE);
    expect(out.steps[0]).not.toHaveProperty('consent');
    expect(out.steps[2]).not.toHaveProperty('consent');
    expect(out.optout_steps).toEqual([]);
    expect(out.expected.consent).toEqual([]);
    expect(state.reads.some(([sql]) => /contact_phones r|comm_consent_state/.test(sql))).toBe(false);
  });
});

describe('A18.4c — the no-payload enroll is unchanged', () => {
  test('no trigger_data and trigger_data {} produce the SHIPPED envelope, reads and request', async () => {
    const cards = [];
    for (const over of [{}, { trigger_data: {} }]) {
      const { db, state } = makeDb();
      const out = await normalizeActionDraft(db, enrollDraft(over), EVIDENCE);
      expect(Object.keys(out)).toEqual(SHIPPED_ENROLL_KEYS);
      // No payload → none of the payload reads happen.
      expect(state.reads.some(([sql]) => /test_input|FROM appts|FROM cases/.test(sql))).toBe(false);
      expect(buildRequest(out)).toEqual({ path: '/sequences/enroll', method: 'POST', body: { contact_id: 77, template_id: 12, trigger_data: {} }, idempotent: true });
      const { draft_id: _id, ...rest } = out;
      cards.push(rest);
    }
    expect(cards[1]).toEqual(cards[0]);
  });
});

describe('A18.4c — the closed key set', () => {
  test('a {{trigger_data}} key step 1 dates itself from: refused without the payload, placed WITH it — the card carries the exact payload and where each key is read', async () => {
    await expect(normalizeActionDraft(makeDb({ published: dated() }).db, enrollDraft(), EVIDENCE))
      .rejects.toThrow(/step 1's timing cannot be computed for an enrollment with no trigger data/);
    const spy = jest.spyOn(engine, 'previewEnrollmentSteps');
    const out = await normalizeActionDraft(makeDb({ published: dated() }).db, xDraft({ court_date: FUTURE, room: '1' }), EVIDENCE_X);
    expect(spy.mock.calls[0][1]).toEqual({ template_id: 12, contact_id: 77, trigger_data: { court_date: FUTURE, room: '1' }, version: 'published' });
    expect(out).toMatchObject({ first_step: 1, placeholder_at_steps: [1] });
    expect(out.payload).toEqual({ trigger_data: { court_date: FUTURE, room: '1' } });
    expect(out.trigger).toEqual({
      reads: [{ key: 'court_date', read_by: [{ step_number: 1, via: 'placeholder' }, { step_number: 1, via: 'delay_at' }] },
        { key: 'room', read_by: [{ step_number: 1, via: 'placeholder' }] }],
      scope: 'contact', appointment: null, case: null,
    });
    // The step resolves from the payload; nothing is left unresolved.
    expect(out.steps[0]).toMatchObject({ placement: 'places', message: 'Court on 2027-01-15T15:00:00Z in 1' });
    expect(out.steps[0]).not.toHaveProperty('unresolved');
    expect(buildRequest(out).body).toEqual({ contact_id: 77, template_id: 12, trigger_data: { court_date: FUTURE, room: '1' } });
    expect(Object.keys(out).slice(0, 7)).toEqual(['draft_id', 'kind', 'status', 'template', 'contact', 'payload', 'trigger']);
  });

  test('a key nothing reads is refused with the allowed list; a version reading nothing says so', async () => {
    await expect(normalizeActionDraft(makeDb({ published: dated() }).db, xDraft({ court_date: FUTURE, zzz: 1 }), EVIDENCE_X))
      .rejects.toThrow(/^Sequence enroll trigger_data key "zzz" is not read by template 12's published version — allowed: court_date, room \(what its steps, conditions, appointment timing/);
    await expect(normalizeActionDraft(makeDb().db, xDraft({ a: 1 }), EVIDENCE_X))
      .rejects.toThrow(/it reads no trigger data key, so enroll with no trigger_data/);
  });

  test('the test_input and captured_input samples (object or JSON text) widen the set; their keys read by no step are disclosed as such', async () => {
    for (const meta of [{ test_input: { source: 'x' } }, { captured_input: JSON.stringify({ source: 'x', 'bad key': 1, contact_id: 5 }) }]) {
      const out = await normalizeActionDraft(makeDb({ meta }).db, xDraft({ source: 'web' }), EVIDENCE_X);
      expect(out.trigger.reads).toEqual([{ key: 'source', read_by: [] }]);
    }
    // A sample key that cannot be a placeholder name is never allowed.
    await expect(normalizeActionDraft(makeDb({ meta: { captured_input: { 'a.b': 1 } } }).db, xDraft({ zzz: 1 }), EVIDENCE_X))
      .rejects.toThrow(/key "zzz" is not read .* it reads no trigger data key/);
  });

  test('condition params, appointment timing, the fire guard and the table bindings are reads the scan sees', async () => {
    const guarded = { ...task(2), fire_guard: JSON.stringify({ min_hours_before_appt: 2 }),
      condition: JSON.stringify({ query: 'SELECT 1 AS ok FROM cases WHERE case_id = :c AND :g IS NOT NULL', params: { c: 'trigger_data.case_id', g: 'stage' }, assert: { ok: 1 } }) };
    const users = sms(3, { type: 'delay', value: 1, unit: 'hours' }, { from: '{{users.default_phone}}', message: 'Re {{appts.appt_type}} on {{cases.case_number}}' });
    const cond = { query: 'SELECT 1 AS ok FROM contacts WHERE contact_id = :k', params: { k: 'trigger_data.kind' }, assert: { ok: 1 } };
    const { db } = makeDb({ published: [sms(1, { type: 'before_appt_fixed', hoursBack: 24 }), guarded, users], cond });
    await expect(normalizeActionDraft(db, xDraft({ zzz: 1 }), EVIDENCE_X))
      .rejects.toThrow(/allowed: appt_id, appt_time, appt_with, case_id, kind, stage \(/);
  });
});

describe('A18.4c — values, names, and what stays refused', () => {
  test('refused names inside trigger_data are refused BY NAME, with the reason, before anything is read', async () => {
    // A18.4d un-refused signing_request_id (evidence-bound, e-sign-scoped):
    // tests/caseySequenceEnrollEsign.test.js pins it.
    const reasons = {
      user: /it binds \{\{users\.\*\}\} to a staff member, and no Casey read cites a user by id/,
      user_id: /it binds \{\{users\.\*\}\} to a staff member/,
      task_id: /it binds \{\{tasks\.\*\}\}/,
      contact_id: /.*would act on a different contact/,
      contact: /.*would act on a different contact/,
      constructor: /a prototype name is never a key/,
    };
    for (const [key, re] of Object.entries(reasons)) {
      const { db } = makeDb();
      await expect(normalizeActionDraft(db, xDraft({ [key]: 1 }), EVIDENCE_X))
        .rejects.toThrow(new RegExp(`^Sequence enroll trigger_data\\.${key} is refused — ${re.source}`));
      expect(db.query).not.toHaveBeenCalled();
    }
    const proto = JSON.parse('{"__proto__":1}');
    await expect(normalizeActionDraft(makeDb().db, xDraft(proto), EVIDENCE_X)).rejects.toThrow(/trigger_data\.__proto__ is refused/);
  });

  test('an object or array value is refused by name; text, numbers, true/false and null pass the shape check', async () => {
    for (const [v, what] of [[{ a: 1 }, 'an object'], [[1], 'an array']]) {
      const { db } = makeDb();
      await expect(normalizeActionDraft(db, xDraft({ room: v }), EVIDENCE_X))
        .rejects.toThrow(new RegExp(`trigger_data\\.room is ${what} — Casey sends scalar values only`));
      expect(db.query).not.toHaveBeenCalled();
    }
    for (const v of ['x', '', 0, -1.5, true, false, null]) {
      const out = await normalizeActionDraft(makeDb({ published: dated() }).db, xDraft({ court_date: FUTURE, room: v }), EVIDENCE_X);
      expect(out.payload.trigger_data.room).toEqual(v);
    }
    for (const bad of [[], null, 'x']) {
      await expect(normalizeActionDraft(makeDb().db, xDraft(bad), EVIDENCE_X)).rejects.toThrow(/trigger_data must be an object/);
    }
  });

  test('A17.7b\'s caps, reused: 500 characters on one line, 20 keys, placeholder-readable names', async () => {
    const ok = await normalizeActionDraft(makeDb({ published: dated() }).db, xDraft({ court_date: FUTURE, room: 'a'.repeat(500) }), EVIDENCE_X);
    expect(ok.payload.trigger_data.room).toHaveLength(500);
    await expect(normalizeActionDraft(makeDb().db, xDraft({ room: 'a'.repeat(501) }), EVIDENCE_X)).rejects.toThrow(/is 501 characters — over 500/);
    for (const bad of ['a\nb', 'a\tb', 'a‮b']) {
      await expect(normalizeActionDraft(makeDb().db, xDraft({ room: bad }), EVIDENCE_X)).rejects.toThrow(/line break, tab, control or text-direction character/);
    }
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    await expect(normalizeActionDraft(makeDb().db, xDraft(many), EVIDENCE_X)).rejects.toThrow(/has 21 keys — one card reviews at most 20/);
    for (const key of ['a.b', 'a b', '1a', 'a-b']) {
      await expect(normalizeActionDraft(makeDb().db, xDraft({ [key]: 1 }), EVIDENCE_X)).rejects.toThrow(/is not a name a \{\{trigger_data\.…\}\} placeholder can read/);
    }
  });
});

describe('A18.4c — case_id: from evidence, linked to the contact', () => {
  const caseTpl = () => [sms(1, { type: 'immediate' }, { message: 'Case {{cases.case_number}}' })];
  test('a cited case linked to the contact binds; the card names it and the relation', async () => {
    const out = await normalizeActionDraft(makeDb({ published: caseTpl() }).db, xDraft({ case_id: 'CASE1' }), EVIDENCE_X);
    expect(out.trigger.case).toEqual({ case_id: 'CASE1', label: '26-12345', caption: 'In re Client', relate_type: 'Primary' });
    expect(out.trigger.reads).toEqual([{ key: 'case_id', read_by: [{ step_number: 1, via: 'binds_cases' }] }]);
  });
  test('uncited, malformed, missing, or another client\'s case is refused', async () => {
    await expect(normalizeActionDraft(makeDb({ published: caseTpl() }).db, enrollDraft({ trigger_data: { case_id: 'CASE1' } }), EVIDENCE_X))
      .rejects.toThrow(/trigger_data\.case_id "CASE1" is not in the evidence/);
    for (const bad of [12, 'a b', '']) {
      await expect(normalizeActionDraft(makeDb({ published: caseTpl() }).db, xDraft({ case_id: bad }), EVIDENCE_X))
        .rejects.toThrow(/case_id must be a case id as text/);
    }
    await expect(normalizeActionDraft(makeDb({ published: caseTpl(), cases: {} }).db, xDraft({ case_id: 'CASE1' }), EVIDENCE_X))
      .rejects.toThrow(/^Case CASE1 is unavailable/);
    await expect(normalizeActionDraft(makeDb({ published: caseTpl() }).db, xDraft({ case_id: 'CASE2' }), EVIDENCE_X))
      .rejects.toThrow(/^Case CASE2 is not linked to Dana Client \(contact 77\) — a sequence's \{\{cases\.\*\}\} placeholders would put another client's case/);
  });
});

describe('A18.4c — appt_id: an appointment-scoped enrollment, from evidence, the contact\'s own appointment', () => {
  const apptTpl = () => [sms(1, { type: 'before_appt_fixed', hoursBack: 24 }, { message: 'See you {{trigger_data.appt_time}} with {{users.user_name}}' }), task(2)];

  test('appt_id + its own appt_time places the appointment-anchored step 1; the card names the appointment and the scope', async () => {
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, enrollDraft(), EVIDENCE))
      .rejects.toThrow(/step 1's timing cannot be computed for an enrollment with no trigger data \(before_appt_fixed requires trigger_data\.appt_time\)/);
    const { db, state } = makeDb({ published: apptTpl() });
    const out = await normalizeActionDraft(db, xDraft({ appt_id: 900, appt_time: APPT_UTC, appt_with: 3 }), EVIDENCE_X);
    expect(out.first_step).toBe(1);
    expect(out.steps[0].placement).toBe('places');
    expect(out.trigger.scope).toBe('appointment');
    expect(out.trigger.appointment).toEqual({ appt_id: 900, when_text: expect.stringMatching(/2:00 PM firm time$/), appt_type: '341 Meeting',
      status: 'Scheduled', past: 0, provider: { user_id: 3, name: 'Stuart' }, case_id: 'CASE1' });
    // The duplicate predicate runs with THIS appointment's scope.
    const dup = state.reads.find(([sql]) => /FROM sequence_enrollments WHERE contact_id/.test(sql));
    expect(dup[1]).toEqual([77, 12, 900, null]);
    expect(buildRequest(out).body.trigger_data).toEqual({ appt_id: 900, appt_time: APPT_UTC, appt_with: 3 });
  });

  test('the contact mismatch is refused with both named; an uncited, malformed or missing appointment too', async () => {
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_id: 901 }), EVIDENCE_X))
      .rejects.toThrow(/^Appointment #901 belongs to Other Person \(contact 78\), not to Dana Client \(contact 77\) — an appointment-scoped enrollment is the appointment's own client's/);
    const clientless = { 900: { ...APPTS[900], appt_client_id: null } };
    await expect(normalizeActionDraft(makeDb({ published: apptTpl(), appts: clientless }).db, xDraft({ appt_id: 900 }), EVIDENCE_X))
      .rejects.toThrow(/^Appointment #900 belongs to no contact \(a client-less appointment\), not to Dana Client/);
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, enrollDraft({ trigger_data: { appt_id: 900 } }), EVIDENCE_X))
      .rejects.toThrow(/trigger_data\.appt_id 900 is not in the evidence/);
    for (const bad of ['900', 0, -1, 1.5]) {
      await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_id: bad }), EVIDENCE_X))
        .rejects.toThrow(/appt_id must be a positive appointment id \(a number\) or null/);
    }
    await expect(normalizeActionDraft(makeDb({ published: apptTpl(), appts: {} }).db, xDraft({ appt_id: 900 }), EVIDENCE_X))
      .rejects.toThrow(/^Appointment 900 is unavailable/);
  });

  test('appt_time and appt_with must be the appointment\'s own, and need the appointment; case_id must be its case', async () => {
    const hourOff = new Date(Date.parse(APPT_UTC) - 3600e3).toISOString();
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const t of [hourOff, APPT_LOCAL, 'soon']) {
      await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_id: 900, appt_time: t }), EVIDENCE_X))
        .rejects.toThrow(new RegExp(`appt_time .* is not appointment #900's time — send "${esc(APPT_UTC)}" \\(its ${esc(APPT_LOCAL)} firm time, as UTC`));
    }
    // The same instant in another spelling is the same time.
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_id: 900, appt_time: APPT_AT.toISO({ suppressMilliseconds: true }) }), EVIDENCE_X))
      .resolves.toMatchObject({ first_step: 1 });
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_time: APPT_UTC }), EVIDENCE_X))
      .rejects.toThrow(/appt_time needs the appointment it belongs to \(appt_id\)/);
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_with: 3 }), EVIDENCE_X))
      .rejects.toThrow(/appt_with binds \{\{users\.\*\}\} to a staff member, and only an appointment \(appt_id\) proves which one/);
    await expect(normalizeActionDraft(makeDb({ published: apptTpl() }).db, xDraft({ appt_id: 900, appt_time: APPT_UTC, appt_with: 4 }), EVIDENCE_X))
      .rejects.toThrow(/appt_with 4 is not appointment #900's provider \(user 3\)/);
    const caseRead = [...apptTpl(), sms(3, { type: 'delay', value: 1, unit: 'hours' }, { message: '{{cases.case_number}}' })];
    const cases = { CASE1: CASES.CASE1, CASE3: { case_id: 'CASE3', label: 'x', case_caption: null, relates: { 77: 'Secondary' } } };
    const ev = [...EVIDENCE_X, { id: 'q5', rows: [{ case_id: 'CASE3' }] }];
    await expect(normalizeActionDraft(makeDb({ published: caseRead, cases }).db,
      xDraft({ appt_id: 900, appt_time: APPT_UTC, case_id: 'CASE3' }, { evidence: [...REFS_X, { query_id: 'q5', row_number: 1 }] }), ev))
      .rejects.toThrow(/case_id "CASE3" is not appointment #900's case \("CASE1"\)/);
  });

  test('the duplicate identity is scoped: a contact-scoped row does not block an appointment-scoped card, and vice versa; the same scope refuses', async () => {
    const tpl = apptTpl();
    // Only a contact-scoped row (appt NULL) exists → the appointment card passes.
    await expect(normalizeActionDraft(makeDb({ published: tpl, existingScoped: [[5501, null]] }).db,
      xDraft({ appt_id: 900, appt_time: APPT_UTC }), EVIDENCE_X)).resolves.toMatchObject({ trigger: { scope: 'appointment' } });
    // Only an appointment-scoped row exists → the contact-scoped card passes.
    await expect(normalizeActionDraft(makeDb({ existingScoped: [[5502, 900]] }).db, enrollDraft(), EVIDENCE)).resolves.toMatchObject({ kind: 'sequence.enroll.v1' });
    // The same appointment → refused, named with its scope.
    await expect(normalizeActionDraft(makeDb({ published: tpl, existingScoped: [[5502, 900]] }).db, xDraft({ appt_id: 900, appt_time: APPT_UTC }), EVIDENCE_X))
      .rejects.toThrow(/^Dana Client \(contact 77\) is already enrolled in "Lead Drip" for appointment #900 — active enrollment #5502; nothing is proposed/);
  });
});

describe('A18.4c — an armed capture is disclosed on both cards', () => {
  test('capturing puts a capture key on both cards; off adds nothing', async () => {
    const plain = await normalizeActionDraft(makeDb({ capture_mode: 'capturing' }).db, enrollDraft(), EVIDENCE);
    expect(plain.capture).toBe('capturing');
    expect(Object.keys(plain)).toEqual([...SHIPPED_ENROLL_KEYS.slice(0, 5), 'capture', ...SHIPPED_ENROLL_KEYS.slice(5)]);
    const fed = await normalizeActionDraft(makeDb({ capture_mode: 'capturing', published: dated() }).db, xDraft({ court_date: FUTURE }), EVIDENCE_X);
    expect(fed.capture).toBe('capturing');
    const off = await normalizeActionDraft(makeDb({ capture_mode: 'off' }).db, enrollDraft(), EVIDENCE);
    expect(off).not.toHaveProperty('capture');
  });
});

describe('A18.4c — the browser sends the reviewed trigger data and nothing else', () => {
  test('the payload goes out exactly; junk beside it changes nothing; a malformed payload sends nothing', async () => {
    const card = await normalizeActionDraft(makeDb({ published: dated() }).db, xDraft({ court_date: FUTURE, room: 7 }), EVIDENCE_X);
    const expected = { path: '/sequences/enroll', method: 'POST', body: { contact_id: 77, template_id: 12, trigger_data: { court_date: FUTURE, room: 7 } }, idempotent: true };
    expect(buildRequest(card)).toEqual(expected);
    expect(buildRequest({ ...card, trigger_data: { x: 1 }, template_type: 'lead', appt_id: 5 })).toEqual(expected);
    const base = { template: { sequence_template_id: 12 }, contact: { contact_id: 77 } };
    for (const payload of [
      { trigger_data: { a: { b: 1 } } }, { trigger_data: { a: [1] } }, { trigger_data: [] }, { trigger_data: null }, [],
      { trigger_data: {}, template_type: 'x' }, { trigger_data: { signing_request_id: 5 } }, { trigger_data: { contact_id: 5 } },
      { trigger_data: { user: 3 } }, { trigger_data: { appt_id: '900' } }, { trigger_data: { 'a.b': 1 } },
      JSON.parse('{"trigger_data":{"__proto__":1}}'),
    ]) {
      expect(() => buildRequest({ ...base, payload })).toThrow(/unusable trigger data/);
    }
  });

  test('the click-time re-check uses the SAME scoped identity', async () => {
    const draft = { template: { sequence_template_id: 12 }, contact: { contact_id: 77, contact_name: 'Dana Client' }, expected: { current_version: 3 },
      payload: { trigger_data: { appt_id: 900 } } };
    const api = (rows) => jest.fn(async (p) => (p === '/sequences/templates/12'
      ? { success: true, template: { id: 12, active: 1, current_version: 3 } }
      : { success: true, enrollments: rows, pagination: { total: rows.length } }));
    const row = (id, appt) => ({ id, contact_id: 77, template_id: 12, appt_id: appt, signing_request_id: null, status: 'active' });
    // A contact-scoped row and another appointment's row do not block.
    await expect(makePrecheck(api([row(1, null), row(2, 901)]))(draft)).resolves.toBe('');
    await expect(makePrecheck(api([row(3, 900)]))(draft))
      .resolves.toBe('Dana Client is already enrolled in this sequence for appointment #900 (active enrollment #3). Nothing was enrolled.');
    // The contact-scoped card is still blocked only by a contact-scoped row.
    const plain = { ...draft, payload: undefined };
    await expect(makePrecheck(api([row(3, 900)]))(plain)).resolves.toBe('');
    await expect(makePrecheck(api([row(4, null)]))(plain)).resolves.toMatch(/already enrolled in this sequence \(active enrollment #4\)/);
  });
});
