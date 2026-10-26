'use strict';
/**
 * tests/caseySequenceStep.test.js
 *
 * A18.2 — Casey inserts ONE sms / email / task step into an existing sequence
 * template's DRAFT (kind sequence.step_insert.v1).
 *
 * The contract pinned here:
 *   1. evidence must carry the exact sequence_template_id (an
 *      automation.definition row) — an id from the model's memory is refused;
 *   2. the action type picks the PINNED function (sequence allowlist,
 *      ruling 14); a draft naming another function, a `type` key, or any
 *      other action_config key is refused; params go through the route's own
 *      __validateSequenceFunctionStep AFTER the allowlist;
 *   3. the sender is a literal active firm line / configured mailbox, or a
 *      placeholder from the engine's closed resolvable set (ruling 15);
 *      email attachments are refused; a literal task assignee must be active
 *      staff;
 *   4. timing takes all seven engine types, closed per type, with the two
 *      guardrails — a literal future delay.at only, and the appointment-
 *      anchored types disclosed as silently skipping — and every value
 *      renders in plain language;
 *   5. the normalizer reads the EDITING version (draft ?? current), bounds
 *      step_number to 1..count+1, and bakes expected_base (+ the displaced
 *      step's fingerprint for an insert-at-position) into the card;
 *   6. end to end: the SHIPPED browser builder's request is accepted by the
 *      REAL routes/sequences.js router (and a stale card gets the conflict
 *      shape); the route honours the draft_id as Idempotency-Key.
 * The SQL predicates (phone_lines / email_credentials / users / the editing
 * version / the enrollment count) run on a real engine in
 * tests/caseySequenceStep.mysql.test.js.
 *
 *   npx jest tests/caseySequenceStep.test.js
 */

const fs = require('fs');
const path = require('path');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 1, roles: ['staff'] }; next(); }));

const svc = require(path.join(__dirname, '..', 'services', 'assistantService'));
const { sequenceStepFingerprint } = require(path.join(__dirname, '..', 'lib', 'versionDiff'));
const { normalizeActionDraft } = svc;

// Template 12: published v3, no draft — the editing version is v3.
const TPL = { id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1, current_version: 3, draft_version: null };
const STEP_ROWS = [
  { step_number: 1, action_type: 'sms',
    action_config: JSON.stringify({ function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'We missed you' } }),
    timing: JSON.stringify({ type: 'immediate' }), condition: null, fire_guard: null,
    error_policy: JSON.stringify({ strategy: 'ignore', max_retries: 0, backoff_seconds: 5 }) },
  { step_number: 2, action_type: 'task',
    action_config: JSON.stringify({ function_name: 'create_task', params: { title: 'Call back', assigned_to: 7 } }),
    timing: JSON.stringify({ type: 'next_business_day', timeOfDay: '13:00', randomizeMinutes: 30 }), condition: null, fire_guard: null, error_policy: null },
  { step_number: 3, action_type: 'email',
    action_config: JSON.stringify({ function_name: 'send_email', params: { from: 'office@4lsg.com', to: '{{contacts.contact_email}}', subject: 'Reschedule', text: 'Hi' } }),
    timing: JSON.stringify({ type: 'business_days', value: 5, timeOfDay: '10:00' }), condition: null, fire_guard: null, error_policy: null },
];

function seqDb(over = {}) {
  const tpl = { ...TPL, ...over };
  return { query: jest.fn(async (sql, params) => {
    if (/FROM sequence_templates WHERE id = \?/.test(sql)) return [params[0] === tpl.id ? [tpl] : []];
    if (/FROM sequence_steps WHERE template_id = \? AND version = \?/.test(sql)) {
      const v = tpl.draft_version != null ? tpl.draft_version : tpl.current_version;
      return [params[0] === tpl.id && params[1] === v ? STEP_ROWS.map((r) => ({ ...r })) : []];
    }
    if (/FROM sequence_enrollments/.test(sql)) return [[{ n: 2 }]];
    if (/FROM phone_lines/.test(sql)) return [params[0] === '2484179800' ? [{ phone_number: '2484179800', display_name: 'office' }] : []];
    if (/FROM email_credentials/.test(sql)) return [String(params[0]).toLowerCase() === 'office@4lsg.com' ? [{ email: 'office@4lsg.com', from_name: '4LSG' }] : []];
    if (/FROM users/.test(sql)) return [params[0] === 7 ? [{ user: 7, user_name: 'Stuart' }] : []];
    throw new Error(`db touched: ${sql}`);
  }) };
}

// Evidence as automation.definition (P12b) produces it: rows carry sequence_template_id.
const EVIDENCE = [{ id: 'q1', label: 'Sequence 12 definition',
  rows: STEP_ROWS.map((r, i) => ({ sequence_template_id: 12, step_number: r.step_number, action_type: r.action_type, row_number: i + 1 })) }];
const CITE = [{ query_id: 'q1', row_number: 1 }];

const smsDraft = (over = {}) => ({
  kind: 'sequence.step_insert.v1', sequence_template_id: 12, action_type: 'sms',
  action_config: { params: { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Reminder: please call us.' } },
  timing: { type: 'delay', value: 2, unit: 'hours' },
  evidence: CITE,
  ...over,
});

afterEach(() => { delete process.env.CASEY_SEQUENCE_AUTHORING_ENABLED; });

describe('sequence.step_insert.v1 — target, evidence, position, base', () => {
  test('an append normalizes with the pinned function, the base and no fingerprint', async () => {
    const out = await normalizeActionDraft(seqDb(), smsDraft(), EVIDENCE);
    expect(out).toMatchObject({ kind: 'sequence.step_insert.v1', status: 'draft', position: null, displaces: null,
      sender: 'office (2484179800)' });
    expect(out.template).toEqual({ sequence_template_id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1,
      published_version: 3, has_draft: 0, active_enrollments: 2 });
    expect(out.step).toEqual({ action_type: 'sms', function_name: 'send_sms', side_effect: 'external-send',
      params: smsDraft().action_config.params, timing: { type: 'delay', value: 2, unit: 'hours' } });
    expect(out.expected_base).toEqual({ draft_version: null, step_count: 3 });
    expect(out.timing_text).toBe('2 hours after the previous step (or after enrollment for step 1)');
    expect(typeof out.draft_id).toBe('string');
  });

  test('inserting at an occupied position fingerprints the displaced step', async () => {
    const out = await normalizeActionDraft(seqDb(), smsDraft({ step_number: 2 }), EVIDENCE);
    expect(out.position).toBe(2);
    expect(out.displaces).toEqual({ step_number: 2, summary: 'task (create_task)' });
    expect(out.expected_base.step_fingerprint).toBe(sequenceStepFingerprint(STEP_ROWS[1]));
  });

  test('step_number is bounded to 1..count+1; count+1 is an append', async () => {
    const out = await normalizeActionDraft(seqDb(), smsDraft({ step_number: 4 }), EVIDENCE);
    expect(out.position).toBeNull();
    expect(out.expected_base).toEqual({ draft_version: null, step_count: 3 });
    for (const bad of [0, 5, 1.5, '2x', -1]) {
      await expect(normalizeActionDraft(seqDb(), smsDraft({ step_number: bad }), EVIDENCE))
        .rejects.toThrow(/position must be 1-4/);
    }
  });

  test('a template with a draft reads the DRAFT (the editing version) and bakes its number', async () => {
    const db = seqDb({ draft_version: 5 });
    const out = await normalizeActionDraft(db, smsDraft(), EVIDENCE);
    expect(out.expected_base).toEqual({ draft_version: 5, step_count: 3 });
    expect(out.template.has_draft).toBe(1);
    const stepRead = db.query.mock.calls.find(([sql]) => /FROM sequence_steps/.test(sql));
    expect(stepRead[1]).toEqual([12, 5]);
  });

  test('evidence that does not carry the sequence_template_id is refused', async () => {
    const wfRows = [{ id: 'q1', label: 'Workflow 12', rows: [{ workflow_id: 12, row_number: 1 }] }];
    await expect(normalizeActionDraft(seqDb(), smsDraft(), wfRows)).rejects.toThrow(/does not identify the target template/);
    await expect(normalizeActionDraft(seqDb(), smsDraft({ evidence: [] }), EVIDENCE)).rejects.toThrow(/does not identify the target template/);
    const other = [{ id: 'q1', label: 'Sequence 13', rows: [{ sequence_template_id: 13, row_number: 1 }] }];
    await expect(normalizeActionDraft(seqDb(), smsDraft(), other)).rejects.toThrow(/does not identify the target template/);
  });

  test('unknown top-level fields are refused by name; an unknown template is unavailable', async () => {
    await expect(normalizeActionDraft(seqDb(), smsDraft({ condition: { query: 'SELECT 1' } }), EVIDENCE))
      .rejects.toThrow(/unsupported fields: condition/);
    await expect(normalizeActionDraft(seqDb(), smsDraft({ error_policy: { strategy: 'abort' } }), EVIDENCE))
      .rejects.toThrow(/unsupported fields: error_policy/);
    const ev13 = [{ id: 'q1', label: 'x', rows: [{ sequence_template_id: 13, row_number: 1 }] }];
    await expect(normalizeActionDraft(seqDb(), smsDraft({ sequence_template_id: 13 }), ev13)).rejects.toThrow(/Sequence template 13 is unavailable/);
  });

  test('the family off switch makes the kind not exist', async () => {
    process.env.CASEY_SEQUENCE_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(seqDb(), smsDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
  });
});

describe('sequence.step_insert.v1 — the allowlist and the action config', () => {
  test('only sms / email / task are authorable', async () => {
    for (const t of ['internal_function', 'webhook', 'start_workflow', 'custom_code', undefined]) {
      await expect(normalizeActionDraft(seqDb(), smsDraft({ action_type: t }), EVIDENCE))
        .rejects.toThrow(/is not authorable — Casey inserts sms, email, or task steps only/);
    }
  });

  test('the function is pinned: another function_name, a type key, or extra config keys are refused', async () => {
    const params = smsDraft().action_config.params;
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { function_name: 'update_db', params } }), EVIDENCE))
      .rejects.toThrow(/always runs send_sms/);
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params, type: 'custom_code' } }), EVIDENCE))
      .rejects.toThrow(/must not contain a "type" key/);
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params, set_vars: { x: 1 } } }), EVIDENCE))
      .rejects.toThrow(/unsupported fields: set_vars/);
    const ok = await normalizeActionDraft(seqDb(), smsDraft({ action_config: { function_name: 'send_sms', params } }), EVIDENCE);
    expect(ok.step.function_name).toBe('send_sms');
  });

  test('params run the route\'s own validator: undeclared and missing params are refused', async () => {
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params: { from: '2484179800', to: 'x', message: 'm', mesage: 'typo' } } }), EVIDENCE))
      .rejects.toThrow(/undeclared key: mesage/);
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params: { from: '2484179800', to: 'x' } } }), EVIDENCE))
      .rejects.toThrow(/required/);
  });

  test('the SMS sender is a literal ACTIVE firm line or a placeholder from the closed set (ruling 15)', async () => {
    await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params: { from: '2485550100', to: 'x', message: 'm' } } }), EVIDENCE))
      .rejects.toThrow(/not an active firm phone line/);
    const literal = await normalizeActionDraft(seqDb(), smsDraft(), EVIDENCE);
    expect(literal.sender).toBe('office (2484179800)');
    expect(literal.sender_note).toBeUndefined();
    // The live form (12 steps, 2026-10-27): shown verbatim, with the plain line.
    const ph = await normalizeActionDraft(seqDb(), smsDraft({ action_config: { params: { from: '{{users.default_phone}}', to: 'x', message: 'm' } } }), EVIDENCE);
    expect(ph.sender).toBe('{{users.default_phone}}');
    expect(ph.sender_note).toMatch(/^sender resolved per enrollment — e\.g\. the enrolling user's default phone/);
    expect(ph.sender_note).toMatch(/fails this step without sending/);
    // Outside the closed set: other channels' forms, settings (no such
    // namespace in a sequence), modifiers, partial strings, unseen trigger_data.
    for (const from of ['{{users.default_email}}', '{{settings.sms_default_from}}', '{{users.default_phone|default:2484179800}}',
      '1{{users.default_phone}}', '{{trigger_data.line}}', '{{contacts.contact_phone}}']) {
      await expect(normalizeActionDraft(seqDb(), smsDraft({ action_config: { params: { from, to: 'x', message: 'm' } } }), EVIDENCE))
        .rejects.toThrow(/a sender placeholder the sequence engine resolves: \{\{users\.default_phone\}\}/);
    }
  });

  test('a {{trigger_data.X}} sender is admitted only when the template already sends from it on that channel', async () => {
    const rows = [...STEP_ROWS.map((r) => ({ ...r })), { step_number: 4, action_type: 'internal_function',
      action_config: { function_name: 'send_email', params: { from: '{{trigger_data.automationsFrom}}', to: 'billing@4lsg.com', subject: 'Failed', text: 'x' } },
      timing: { type: 'immediate' }, condition: null, fire_guard: null, error_policy: null }];
    const db = seqDb();
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => (/FROM sequence_steps WHERE template_id/.test(sql) ? [rows] : base(sql, params)));
    const email = (from) => smsDraft({ action_type: 'email', action_config: { params: { from, to: '{{contacts.contact_email}}', subject: 'S', text: 'T' } } });
    const out = await normalizeActionDraft(db, email('{{trigger_data.automationsFrom}}'), EVIDENCE);
    expect(out.sender).toBe('{{trigger_data.automationsFrom}}');
    expect(out.sender_note).toMatch(/same sender this template's other email steps already use/);
    // Same placeholder on the OTHER channel is not an echo.
    await expect(normalizeActionDraft(db, smsDraft({ action_config: { params: { from: '{{trigger_data.automationsFrom}}', to: 'x', message: 'm' } } }), EVIDENCE))
      .rejects.toThrow(/sender placeholder the sequence engine resolves/);
    // Without the echo (the default template) it is refused.
    await expect(normalizeActionDraft(seqDb(), email('{{trigger_data.automationsFrom}}'), EVIDENCE))
      .rejects.toThrow(/sender placeholder the sequence engine resolves: \{\{users\.default_email\}\}/);
  });

  test('email: a configured mailbox sender, no attachments', async () => {
    const email = (params) => smsDraft({ action_type: 'email', action_config: { params } });
    const out = await normalizeActionDraft(seqDb(), email({ from: 'office@4lsg.com', to: '{{contacts.contact_email}}', subject: 'S', text: 'T' }), EVIDENCE);
    expect(out.step).toMatchObject({ function_name: 'send_email', side_effect: 'external-send' });
    expect(out.sender).toBe('4LSG <office@4lsg.com>');
    await expect(normalizeActionDraft(seqDb(), email({ from: 'nobody@example.com', to: 'x', subject: 'S', text: 'T' }), EVIDENCE))
      .rejects.toThrow(/not a configured firm mailbox/);
    const ph = await normalizeActionDraft(seqDb(), email({ from: '{{users.default_email}}', to: 'x', subject: 'S', text: 'T' }), EVIDENCE);
    expect(ph.sender).toBe('{{users.default_email}}');
    expect(ph.sender_note).toMatch(/enrolling user's default email/);
    await expect(normalizeActionDraft(seqDb(), email({ from: '{{users.default_email}}', to: 'x', subject: 'S', text: 'T', attachment_urls: ['https://x.example.com/a.pdf'] }), EVIDENCE))
      .rejects.toThrow(/does not author email attachments/);
    await expect(normalizeActionDraft(seqDb(), email({ from: 'office@4lsg.com', to: 'x', subject: 'S', text: 'T', attachment_urls: ['https://x.example.com/a.pdf'] }), EVIDENCE))
      .rejects.toThrow(/does not author email attachments/);
  });

  test('task: a literal assignee must be active staff; a placeholder is shown as resolved per enrollment', async () => {
    const task = (params) => smsDraft({ action_type: 'task', action_config: { params } });
    const ok = await normalizeActionDraft(seqDb(), task({ title: 'Call', assigned_to: 7 }), EVIDENCE);
    expect(ok.step).toMatchObject({ function_name: 'create_task', side_effect: 'internal-record' });
    expect(ok.assignee).toBe('Stuart (#7)');
    expect(ok.sender).toBeUndefined();
    await expect(normalizeActionDraft(seqDb(), task({ title: 'Call', assigned_to: 99 }), EVIDENCE))
      .rejects.toThrow(/Task assignee 99 is not an active staff member/);
    const ph = await normalizeActionDraft(seqDb(), task({ title: 'Call', assigned_to: '{{trigger_data.user_id}}' }), EVIDENCE);
    expect(ph.assignee).toBe('resolved per enrollment from {{trigger_data.user_id}}');
  });
});

describe('sequence.step_insert.v1 — the timing contract', () => {
  const norm = (timing) => normalizeActionDraft(seqDb(), smsDraft({ timing }), EVIDENCE);
  const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);

  test('every engine timing type is accepted and rendered in plain language', async () => {
    const cases = [
      [{ type: 'immediate' }, /^Immediately/],
      [{ type: 'delay', value: 30, unit: 'minutes', randomizeMinutes: 5 }, /^30 minutes after the previous step .*randomized ±5 min$/],
      [{ type: 'delay', at: `${future} 10:00:00` }, /^At one fixed moment: .*firm time$/],
      [{ type: 'next_business_day', timeOfDay: '15:00', randomizeMinutes: 30 }, /^The next business day at 15:00 firm time, randomized ±30 min$/],
      [{ type: 'business_days', value: 3, timeOfDay: '10:00', minDaysAhead: 1, noSunday: true }, /^3 business days later at 10:00 firm time, at least 1 day out, never on a Sunday$/],
      [{ type: 'open_delay', delay: { value: 15, unit: 'minutes' }, jitter: 5, rollTime: '09:15', dayWindow: { start: 9, end: 19 } },
        /^15 minutes after the previous step .*randomized ±5 min, moved past Shabbos\/Yom Tov to just after it ends; outside 9:00-19:00 it moves to 09:15$/],
      [{ type: 'before_appt', hoursBack: 48, timeOfDay: '09:00' }, /^2 days before the appointment, set to 09:00 firm time on that day; moved earlier past Shabbos\/Yom Tov \(up to 14 days back\), never closer than 1 hour to the appointment$/],
      [{ type: 'before_appt', hoursBack: 72, sameTimeAsAnchor: true }, /^3 days before the appointment, at the appointment's own time of day/],
      [{ type: 'before_appt_fixed', hoursBack: 0.05 }, /^Exactly 3 minutes before the appointment$/],
    ];
    for (const [timing, re] of cases) {
      const out = await norm(timing);
      expect({ type: timing.type, text: out.timing_text }).toEqual({ type: timing.type, text: expect.stringMatching(re) });
      expect(out.step.timing).toEqual(timing.type === 'next_business_day' || timing.type === 'business_days'
        ? expect.objectContaining({ ...timing }) : timing);
    }
  });

  test('the appointment-anchored types carry the silent-skip disclosure; the others do not', async () => {
    for (const timing of [{ type: 'before_appt', hoursBack: 24, sameTimeAsAnchor: true }, { type: 'before_appt_fixed', hoursBack: 2 }]) {
      const out = await norm(timing);
      expect(out.timing_notes.join(' ')).toMatch(/SILENTLY SKIPPED as unschedulable/);
      expect(out.timing_notes.join(' ')).toMatch(/trigger_data\.appt_time/);
    }
    for (const timing of [{ type: 'immediate' }, { type: 'delay', value: 1, unit: 'days' }, { type: 'open_delay' }]) {
      expect((await norm(timing)).timing_notes.join(' ')).not.toMatch(/SKIPPED/);
    }
  });

  test('delay.at is LITERAL and in the future (the placeholder-wedge guardrail)', async () => {
    await expect(norm({ type: 'delay', at: '{{trigger_data.welcome_at}}' })).rejects.toThrow(/must be a literal datetime/);
    await expect(norm({ type: 'delay', at: '{{trigger_data.d21}} 08:00:00' })).rejects.toThrow(/must be a literal datetime/);
    await expect(norm({ type: 'delay', at: '2020-01-01 09:00:00' })).rejects.toThrow(/is in the past/);
    await expect(norm({ type: 'delay', at: 'next tuesday' })).rejects.toThrow(/delay\.at/);
    await expect(norm({ type: 'delay', at: `${future} 10:00:00`, value: 1, unit: 'hours' })).rejects.toThrow(/not both/);
    const out = await norm({ type: 'delay', at: `${future} 10:00:00` });
    expect(out.timing_notes.join(' ')).toMatch(/ONE fixed moment for every enrollment/);
  });

  test('impossible values and foreign keys are refused per type', async () => {
    const bad = [
      [{ type: 'whenever' }, /type must be one of/],
      [null, /must be an object/],
      [{ type: 'immediate', value: 1 }, /immediate does not take value/],
      [{ type: 'delay', value: 0, unit: 'hours' }, /positive number/],
      [{ type: 'delay', value: -2, unit: 'hours' }, /positive number/],
      [{ type: 'delay', value: 2, unit: 'weeks' }, /seconds, minutes, hours, or days/],
      [{ type: 'delay', value: 400, unit: 'days' }, /longer than 366 days/],
      [{ type: 'delay', value: 2, unit: 'hours', randomizeMinutes: 2000 }, /randomizeMinutes must be a whole number from 0 to 1440/],
      [{ type: 'next_business_day', timeOfDay: '25:00' }, /HH:MM/],
      [{ type: 'next_business_day', timeOfDay: '9:00' }, /HH:MM/],
      [{ type: 'next_business_day', timeOfDay: '09:00', timezone: 'America/Chicago' }, /does not take timezone \(steps always run on firm time\)/],
      [{ type: 'business_days', timeOfDay: '10:00' }, /needs value/],
      [{ type: 'business_days', value: 0, timeOfDay: '10:00' }, /value must be a whole number from 1 to 60/],
      [{ type: 'business_days', value: 2, maxDaysAhead: 5 }, /business_days does not take maxDaysAhead/],
      [{ type: 'next_business_day', noSunday: 'yes' }, /noSunday must be true or false/],
      [{ type: 'open_delay', dayWindow: { start: 19, end: 9 } }, /dayWindow/],
      [{ type: 'open_delay', delay: { value: 5, unit: 'minutes', extra: 1 } }, /open_delay.delay must be/],
      [{ type: 'before_appt', timeOfDay: '09:00' }, /hoursBack must be a positive number/],
      [{ type: 'before_appt_fixed', hoursBack: 0 }, /hoursBack must be a positive number/],
      [{ type: 'before_appt_fixed', hoursBack: 2, timeOfDay: '09:00' }, /before_appt_fixed does not take timeOfDay/],
      [{ type: 'before_appt', hoursBack: 24, sameTimeAsAnchor: true, timeOfDay: '09:00' }, /not both/],
    ];
    for (const [timing, re] of bad) {
      await expect(norm(timing)).rejects.toThrow(re);
    }
  });

  test('the vocabulary is exactly the route\'s ALLOWED_TIMING_TYPES — a new engine type cannot slip past unreviewed', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sequences.js'), 'utf8');
    const m = /const ALLOWED_TIMING_TYPES = \[([\s\S]*?)\];/.exec(route);
    const routeTypes = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    const service = fs.readFileSync(path.join(__dirname, '..', 'services', 'assistantService.js'), 'utf8');
    const block = /const SEQUENCE_TIMING_KEYS = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(service)[1];
    const ours = [...block.matchAll(/^\s+([a-z_]+):/gm)].map((x) => x[1]).sort();
    expect(ours).toEqual(routeTypes);
  });
});

// ── End to end: normalizer → the SHIPPED browser builder → the REAL route ──
// The phone-delivery S2 scar: request shapes come from public/assistant.html's
// actual builder and must be accepted by the actual routes/sequences.js
// router, validators included — not by a harness encoding what I think the
// route takes. The route db is a scripted world matching the normalizer's.
describe('end to end: the card request is the route\'s shape', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'assistant.html'), 'utf8');
  function constSrc(src, name) {
    const match = new RegExp(`const\\s+${name}\\s*=`).exec(src);
    let depth = 0;
    for (let i = match.index; i < src.length; i++) {
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) return src.slice(match.index, i + 1);
    }
    throw new Error(`const ${name} unterminated`);
  }
  function fnSrc(src, name) {
    const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
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
  const buildRequest = new Function(`${constSrc(html, 'SEQUENCE_STEP_FUNCTIONS')}\n${constSrc(html, 'SEQUENCE_STEP_ERROR_POLICY')}\n` +
    `${fnSrc(html, 'sequenceStepActionRequest')}; return sequenceStepActionRequest;`)();

  function routeWorld() {
    let rows = STEP_ROWS.map((r) => ({ ...r }));
    let draft = null;
    const idem = [];
    const writes = [];
    const script = async (sql, params = []) => {
      if (/INSERT INTO request_idempotency/.test(sql)) {
        if (idem.find((r) => r.scope === params[1] && r.key === params[2])) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
        idem.push({ id: idem.length + 1, user: params[0], scope: params[1], key: params[2], status: 'in_flight', result: null });
        return [{ insertId: idem.length }];
      }
      if (/DELETE FROM request_idempotency/.test(sql)) { const i = idem.findIndex((r) => r.id === params[0]); if (i >= 0) idem.splice(i, 1); return [{ affectedRows: 1 }]; }
      if (/SELECT .* FROM request_idempotency/.test(sql)) {
        const row = idem.find((r) => r.scope === params[1] && r.key === params[2]);
        return [row ? [{ id: row.id, status: row.status, result: row.result, age_s: 0 }] : []];
      }
      if (/UPDATE request_idempotency/.test(sql)) { const row = idem.find((r) => r.id === params[1]); row.status = 'applied'; row.result = params[0]; return [{ affectedRows: 1 }]; }
      if (/SELECT current_version, draft_version FROM sequence_templates WHERE id = \? FOR UPDATE/.test(sql)) {
        return [[{ current_version: 3, draft_version: draft }]];
      }
      if (/SELECT COUNT\(\*\) AS n FROM sequence_steps/.test(sql)) return [[{ n: rows.length }]];
      if (/SELECT action_type, action_config, timing, `condition`, fire_guard, error_policy\s+FROM sequence_steps/.test(sql)) {
        const row = rows.find((r) => r.step_number === params[2]);
        return [row ? [row] : []];
      }
      if (/SELECT COALESCE\(MAX\(version\), 0\) AS mx FROM sequence_template_versions/.test(sql)) return [[{ mx: 3 }]];
      if (/INSERT INTO sequence_steps \(template_id, version, step_number, action_type, action_config, timing, `condition`, fire_guard, error_policy\)\s+SELECT/.test(sql)) return [{ affectedRows: rows.length }];
      if (/INSERT INTO sequence_template_versions/.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE sequence_templates SET draft_version/.test(sql)) { draft = params[0]; return [{ affectedRows: 1 }]; }
      if (/SELECT MAX\(step_number\) as max FROM sequence_steps/.test(sql)) return [[{ max: rows.length }]];
      if (/UPDATE sequence_steps SET step_number/.test(sql)) return [{ affectedRows: 1 }];
      if (/INSERT INTO sequence_steps/.test(sql)) {
        writes.push(params);
        rows = [...rows, { step_number: params[2], action_type: params[3], action_config: params[4], timing: params[5],
          condition: params[6], fire_guard: params[7], error_policy: params[8] }];
        return [{ insertId: 900 + writes.length }];
      }
      throw new Error(`route db unscripted: ${sql}`);
    };
    return { db: { query: script, getConnection: () => {}, withTransaction: async (fn) => fn({ query: script }) }, writes, idem, setRows: (r) => { rows = r; } };
  }

  function sendToRoute(world, request, headers = {}) {
    const express = require('express');
    const http = require('http');
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.db = world.db; next(); });
    a.use(require('../routes/sequences.js'));
    const data = JSON.stringify(request.body);
    return new Promise((resolve, reject) => {
      const server = a.listen(0, () => {
        const req = http.request({
          port: server.address().port, path: request.path, method: request.method,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
        }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(out || '{}') }); });
        });
        req.on('error', (e) => { server.close(); reject(e); });
        req.write(data); req.end();
      });
    });
  }

  test('one card per action type and per timing type applies through the real route', async () => {
    const future = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const timings = [{ type: 'immediate' }, { type: 'delay', value: 2, unit: 'hours', randomizeMinutes: 5 },
      { type: 'delay', at: `${future} 10:00:00` }, { type: 'next_business_day', timeOfDay: '15:00', maxDaysAhead: 10 },
      { type: 'business_days', value: 2, timeOfDay: '10:00', noSunday: true },
      { type: 'open_delay', delay: { value: 15, unit: 'minutes' }, jitter: 5, rollTime: '09:15', dayWindow: { start: 9, end: 19 } },
      { type: 'before_appt', hoursBack: 48, timeOfDay: '09:00', minHoursBefore: 2, maxDaysBack: 7 },
      { type: 'before_appt_fixed', hoursBack: 2 }];
    const configs = [
      ['sms', { from: '2484179800', to: '{{contacts.contact_phone}}', message: 'Hi' }],
      ['email', { from: 'office@4lsg.com', to: '{{contacts.contact_email}}', subject: 'S', text: 'T', include_signature: true }],
      ['task', { title: 'Call', assigned_to: 7, description: 'D' }],
    ];
    for (const [actionType, params] of configs) {
      for (const timing of timings) {
        const card = await normalizeActionDraft(seqDb(), smsDraft({ action_type: actionType, action_config: { params }, timing }), EVIDENCE);
        const world = routeWorld();
        const request = buildRequest(card);
        const r = await sendToRoute(world, request, { 'idempotency-key': card.draft_id });
        expect({ actionType, timing: timing.type, status: r.status, body: r.body.error || null })
          .toEqual({ actionType, timing: timing.type, status: 201, body: null });
        const written = world.writes[0];
        expect(written[3]).toBe(actionType);
        expect(JSON.parse(written[4])).toEqual({ function_name: { sms: 'send_sms', email: 'send_email', task: 'create_task' }[actionType], params });
        expect(JSON.parse(written[5])).toEqual(timing);
        expect([written[6], written[7]]).toEqual([null, null]);           // no condition / fire guard
        expect(JSON.parse(written[8])).toEqual({ strategy: 'ignore', max_retries: 0, backoff_seconds: 5 });
      }
    }
  });

  test('insert-at-position lands at the reviewed slot; a stale card gets the conflict shape and writes nothing', async () => {
    const card = await normalizeActionDraft(seqDb(), smsDraft({ step_number: 2 }), EVIDENCE);
    const world = routeWorld();
    const ok = await sendToRoute(world, buildRequest(card), { 'idempotency-key': card.draft_id });
    expect({ status: ok.status, stepNumber: ok.body.stepNumber }).toEqual({ status: 201, stepNumber: 2 });

    // Someone edits step 2 between proposal and click.
    const stale = await normalizeActionDraft(seqDb(), smsDraft({ step_number: 2 }), EVIDENCE);
    const moved = routeWorld();
    moved.setRows(STEP_ROWS.map((r) => (r.step_number === 2 ? { ...r, timing: JSON.stringify({ type: 'immediate' }) } : { ...r })));
    const refused = await sendToRoute(moved, buildRequest(stale), { 'idempotency-key': stale.draft_id });
    expect(refused.status).toBe(409);
    expect(refused.body.conflict.changed).toBe('step_fingerprint');
    expect(moved.writes).toEqual([]);
    expect(moved.idem).toEqual([]);   // the refusal released the claim
  });

  test('the draft_id as Idempotency-Key replays the first insert instead of adding the step twice', async () => {
    const card = await normalizeActionDraft(seqDb(), smsDraft(), EVIDENCE);
    const world = routeWorld();
    const request = buildRequest(card);
    const first = await sendToRoute(world, request, { 'idempotency-key': card.draft_id });
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBeUndefined();
    const second = await sendToRoute(world, request, { 'idempotency-key': card.draft_id });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ success: true, stepNumber: first.body.stepNumber, replayed: true });
    expect(world.writes).toHaveLength(1);
    expect(world.idem.map((r) => r.scope)).toEqual(['sequences.step_insert']);
  });

  test('a native caller with no key is untouched: no claim row, same 201 body', async () => {
    const world = routeWorld();
    const r = await sendToRoute(world, { path: '/sequences/templates/12/steps', method: 'POST',
      body: { action_type: 'task', action_config: { function_name: 'create_task', params: { title: 'x', assigned_to: 7 } }, timing: { type: 'immediate' } } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ success: true, stepId: 901, stepNumber: 4 });
    expect(world.idem).toEqual([]);
  });

  test('the builder pins the function per type and ignores the draft\'s own function_name', async () => {
    const card = await normalizeActionDraft(seqDb(), smsDraft(), EVIDENCE);
    card.step.function_name = 'update_db';
    expect(buildRequest(card).body.action_config.function_name).toBe('send_sms');
    card.step.action_type = 'webhook';
    expect(() => buildRequest(card)).toThrow(/cannot be applied from a card/);
  });
});

describe('the settings pair', () => {
  test('the flag is registered in BOTH places', () => {
    const { cfg } = require(path.join(__dirname, '..', 'lib', 'firmConfig'));
    expect(() => cfg('casey_sequence_authoring_enabled')).not.toThrow();
    const { SETTINGS } = require(path.join(__dirname, '..', 'lib', 'settingsRegistry'));
    expect(SETTINGS.casey_sequence_authoring_enabled).toMatchObject({ kind: 'system', type: 'bool' });
  });
});
