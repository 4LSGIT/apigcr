'use strict';
/**
 * tests/caseySequencePublish.test.js
 *
 * A18.3 — Casey publishes a sequence template's draft through the reviewed
 * card (kind sequence.publish.v1), and POST /sequences/templates/:id/publish
 * gains the P11 expected_base precondition. A17.6 on the sequence engine.
 *
 * The contract pinned here:
 *   1. the card is the impact preview, server-computed with draft-diff's own
 *      functions: classification under the STRICTER sequence rule (template
 *      condition included), per-step diff, validation by the route's own
 *      validateSequenceDraft, running / stranded enrollment counts, what can
 *      enroll it, external effects (webhook URLs reduced to method + host,
 *      sends named external-send with their recipient), and the whole-draft
 *      fingerprint — steps AND the draft's template condition — in
 *      expected_base;
 *   2. no sequence action type carries a runnable code body, so A17.6's code
 *      refusal has nothing to bite on — the action-type inventory is pinned
 *      instead, and a stored type the card was not reviewed against refuses;
 *   3. the route refuses a publish whose reviewed base moved — draft_version,
 *      step_count, or the fingerprint (a step edit OR a template-condition
 *      edit) — with a structured 409 before any write; absent expected_base
 *      leaves native callers unchanged, with no extra query;
 *   4. end to end, the SHIPPED browser builder's request is the route's shape
 *      (the phone-delivery S2 stub lesson), migrate_in_flight pinned false, so
 *      no enrollment is repointed.
 * The SQL (the route's condition read inside the transaction, the counts, the
 * fingerprint over rows mysql2 returns) runs on a real engine in
 * tests/caseySequencePublish.mysql.test.js.
 *
 *   npx jest tests/caseySequencePublish.test.js
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

jest.mock('../lib/auth.jwtOrApiKey', () =>
  jest.fn((req, _res, next) => { req.auth = { type: 'jwt', userId: 1, roles: ['staff'], username: 'tester' }; next(); }));

const REPO = path.join(__dirname, '..');
const { normalizeActionDraft } = require(path.join(REPO, 'services', 'assistantService'));
const { sequenceDraftFingerprint, sequenceStepFingerprint } = require(path.join(REPO, 'lib', 'versionDiff'));

// Template 12: published v3 (two steps), draft v4 (sms text tweak on step 1 +
// an appended email). Structural (step added). The draft's template
// condition equals the published one.
const TPL = { id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1, current_version: 3, draft_version: 4 };
const COND = { query: 'SELECT appt_status FROM appts WHERE appt_id = :appt_id', params: { appt_id: 'appt_id' }, assert: { appt_status: 'No Show' } };
const POLICY = JSON.stringify({ strategy: 'ignore', max_retries: 0, backoff_seconds: 5 });
const sms = (n, message) => ({ step_number: n, action_type: 'sms',
  action_config: JSON.stringify({ function_name: 'send_sms', params: { from: '2484179800', to: '{{contacts.contact_phone}}', message } }),
  timing: JSON.stringify({ type: 'immediate' }), condition: null, fire_guard: null, error_policy: POLICY });
const task = (n) => ({ step_number: n, action_type: 'task',
  action_config: JSON.stringify({ function_name: 'create_task', params: { title: 'Call back', assigned_to: 7 } }),
  timing: JSON.stringify({ type: 'next_business_day', timeOfDay: '13:00' }), condition: null, fire_guard: null, error_policy: null });
const email = (n) => ({ step_number: n, action_type: 'email',
  action_config: JSON.stringify({ function_name: 'send_email', params: { from: 'office@4lsg.com', to: '{{contacts.contact_email}}', subject: 'Reschedule', text: 'Hi' } }),
  timing: JSON.stringify({ type: 'business_days', value: 5, timeOfDay: '10:00' }), condition: null, fire_guard: null, error_policy: null });
const CURRENT_STEPS = [sms(1, 'We missed you'), task(2)];
const DRAFT_STEPS = [sms(1, 'We missed you today'), task(2), email(3)];

function makeDb(over = {}) {
  const state = {
    tpl: { ...TPL, ...(over.tpl || {}) },
    draftSteps: (over.draftSteps || DRAFT_STEPS).map((s) => ({ ...s })),
    currentSteps: (over.currentSteps || CURRENT_STEPS).map((s) => ({ ...s })),
    conds: { 3: JSON.stringify(COND), 4: JSON.stringify(COND), ...(over.conds || {}) },
    writes: [],
    reads: [],
  };
  const script = async (sql, params = []) => {
    state.reads.push(sql);
    if (/SELECT id, name, type, active, current_version, draft_version FROM sequence_templates WHERE id = \?/.test(sql)) {
      return [params[0] === state.tpl.id ? [{ ...state.tpl }] : []];
    }
    if (/SELECT id, type FROM sequence_templates WHERE id = \?/.test(sql)) return [[{ id: state.tpl.id, type: state.tpl.type }]];
    if (/SELECT current_version, draft_version FROM sequence_templates WHERE id = \? FOR UPDATE/.test(sql)) {
      return [[{ current_version: state.tpl.current_version, draft_version: state.tpl.draft_version }]];
    }
    if (/SELECT \* FROM sequence_steps WHERE template_id = \? AND version = \?/.test(sql)) {
      if (params[1] === state.tpl.draft_version) return [state.draftSteps.map((s) => ({ ...s }))];
      if (params[1] === state.tpl.current_version) return [state.currentSteps.map((s) => ({ ...s }))];
      return [[]];
    }
    if (/SELECT version, template_condition FROM sequence_template_versions WHERE template_id = \? AND version IN \(\?, \?\)/.test(sql)) {
      return [[params[1], params[2]].filter((v) => v in state.conds).map((v) => ({ version: v, template_condition: state.conds[v] }))];
    }
    if (/SELECT template_condition FROM sequence_template_versions WHERE template_id = \? AND version = \?/.test(sql)) {
      return [params[1] in state.conds ? [{ template_condition: state.conds[params[1]] }] : []];
    }
    if (/FROM sequence_enrollments WHERE template_id = \? AND template_version = \? AND status = 'active'/.test(sql)) return [[{ n: 2 }]];
    if (/FROM sequence_enrollments WHERE template_id = \? AND template_version <> \? AND status = 'active'/.test(sql)) return [[{ n: 1 }]];
    if (/SELECT id FROM workflows WHERE id = \?/.test(sql)) return [[{ id: params[0] }]];
    // automationReadService.sequenceReferences
    if (/FROM hook_targets ht JOIN hooks h/.test(sql)) {
      return [[{ target_id: 9, target_name: 'enroll', target_active: 1, config: JSON.stringify({ template_id: 12 }), hook_id: 5, hook_name: 'No-show hook' }]];
    }
    if (/FROM trigger_rule_actions a JOIN trigger_rules tr/.test(sql)) return [[]];
    if (/FROM workflow_steps s JOIN workflows w/.test(sql)) return [[]];
    if (/FROM cta_links/.test(sql)) return [[]];
    if (/FROM (?:email|phone)_ingest_rule_actions a JOIN/.test(sql)) return [[]];
    if (/^\s*UPDATE /.test(sql)) {
      state.writes.push(sql.trim().split('\n')[0].trim());
      return [{ affectedRows: 1 }];
    }
    throw new Error(`unscripted query: ${sql}`);
  };
  return { state, db: { query: jest.fn(script), withTransaction: async (fn) => fn({ query: script }) } };
}

const EVIDENCE = [{ id: 'q1', label: 'Sequence 12 definition', rows: [{ sequence_template_id: 12, step_number: 1, row_number: 1 }] }];
const publishDraft = (over = {}) => ({
  kind: 'sequence.publish.v1', sequence_template_id: 12,
  evidence: [{ query_id: 'q1', row_number: 1 }], ...over,
});

afterEach(() => { delete process.env.CASEY_SEQUENCE_AUTHORING_ENABLED; });

describe('the sequence-publish normalizer', () => {
  test('a valid publish normalizes into the full impact preview', async () => {
    const { db } = makeDb();
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out).toMatchObject({
      kind: 'sequence.publish.v1', status: 'draft',
      template: { sequence_template_id: 12, name: 'No-Show Follow-Up', type: 'no_show', active: 1 },
      publish: { from_version: 3, to_version: 4, step_count: 3 },
      classification: 'structural',
      in_flight_count: 2, stranded_count: 1,
    });
    expect(out.structural_reasons).toEqual(['step count changed (2 → 3)', 'step 3 added']);
    expect(out.changes).toEqual([{ step_number: 3, kind: 'added' }, { step_number: 1, kind: 'modified', fields: ['action_config'] }]);
    expect(out.validation_warnings).toEqual([]);
    expect(out.starters).toEqual([{ source: 'hook', name: 'No-show hook', active: 1 }]);
    expect(out.effects).toEqual([
      'step 1: send_sms — external-send: messages {{contacts.contact_phone}} on every enrollment that reaches it',
      'step 3: send_email — external-send: messages {{contacts.contact_email}} on every enrollment that reaches it',
    ]);
    expect(out.expected_base).toEqual({
      draft_version: 4, step_count: 3, draft_fingerprint: sequenceDraftFingerprint(DRAFT_STEPS, JSON.stringify(COND)),
    });
    expect(typeof out.draft_id).toBe('string');
    expect(out).not.toHaveProperty('migrate_in_flight');
  });

  test('the stricter rule: an sms text edit alone is content_only; a timing edit is structural', async () => {
    const textOnly = makeDb({ draftSteps: [sms(1, 'We missed you today'), task(2)] });
    expect((await normalizeActionDraft(textOnly.db, publishDraft(), EVIDENCE)).classification).toBe('content_only');
    const retimed = { ...task(2), timing: JSON.stringify({ type: 'next_business_day', timeOfDay: '14:00' }) };
    const timing = makeDb({ draftSteps: [sms(1, 'We missed you'), retimed] });
    const out = await normalizeActionDraft(timing.db, publishDraft(), EVIDENCE);
    expect(out.classification).toBe('structural');
    expect(out.structural_reasons).toEqual(['step 2: timing changed']);
  });

  test('a template-condition edit is structural, and it moves the draft fingerprint', async () => {
    const edited = { ...COND, assert: { appt_status: 'Canceled' } };
    const { db } = makeDb({ draftSteps: CURRENT_STEPS, conds: { 4: JSON.stringify(edited) } });
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out.classification).toBe('structural');
    expect(out.structural_reasons).toEqual(['template condition changed']);
    expect(out.changes).toEqual([{ step_number: null, kind: 'modified', fields: ['template_condition'] }]);
    expect(out.expected_base.draft_fingerprint).toBe(sequenceDraftFingerprint(CURRENT_STEPS, edited));
    expect(out.expected_base.draft_fingerprint).not.toBe(sequenceDraftFingerprint(CURRENT_STEPS, COND));
  });

  test('a first publish is classified first_publish and reads no current steps', async () => {
    const { db } = makeDb({ tpl: { current_version: 0, draft_version: 1 } });
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out.classification).toBe('first_publish');
    expect(out.publish).toEqual({ from_version: 0, to_version: 1, step_count: 3 });
    expect(db.query.mock.calls.filter(([sql, p]) => /FROM sequence_steps/.test(sql) && p[1] === 0)).toEqual([]);
  });

  test('webhook effects reduce to method + host (no secret); start_workflow and DB-write functions are named', async () => {
    const steps = [...DRAFT_STEPS,
      { ...task(4), action_type: 'webhook', action_config: JSON.stringify({ url: 'https://api.example.com/v1/x?token=SECRET', method: 'post' }) },
      { ...task(5), action_type: 'webhook', action_config: JSON.stringify({ url: '{{base}}/hook', method: 'PUT' }) },
      { ...task(6), action_type: 'start_workflow', action_config: JSON.stringify({ workflow_id: 27 }) },
      { ...task(7), action_type: 'internal_function', action_config: JSON.stringify({ function_name: 'update_db', params: {} }) },
      { ...task(8), action_type: 'internal_function', action_config: JSON.stringify({ function_name: 'lookup_contact', params: {} }) },
    ];
    const { db } = makeDb({ draftSteps: steps });
    const out = await normalizeActionDraft(db, publishDraft(), EVIDENCE);
    expect(out.effects.slice(2)).toEqual([
      'step 4: webhook POST → api.example.com',
      'step 5: webhook PUT → templated URL',
      'step 6: start_workflow → workflow #27 — starts a workflow run on every enrollment that reaches it',
      'step 7: update_db',
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  test('no draft, an empty draft, validation errors, bad evidence, extra fields, and the off switch all refuse', async () => {
    const { db: noDraft } = makeDb({ tpl: { draft_version: null } });
    await expect(normalizeActionDraft(noDraft, publishDraft(), EVIDENCE)).rejects.toThrow(/no unpublished changes/);

    const { db: empty } = makeDb({ draftSteps: [] });
    await expect(normalizeActionDraft(empty, publishDraft(), EVIDENCE)).rejects.toThrow(/draft has no steps/);

    // The route's own validator: a `type` key in action_config, a bad timing, a gap in numbering.
    for (const [bad, why] of [
      [[sms(1, 'x'), { ...task(2), action_config: JSON.stringify({ type: 'custom_code', code: '1' }) }], /step 2: The step's action_type selects the dispatch; a "type" key/],
      [[sms(1, 'x'), { ...task(2), timing: JSON.stringify({ type: 'whenever' }) }], /step 2:/],
      [[sms(1, 'x'), task(3)], /not contiguous/],
    ]) {
      const { db } = makeDb({ draftSteps: bad });
      await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE)).rejects.toThrow(why);
      await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE)).rejects.toThrow(/fails publish validation/);
    }

    const { db } = makeDb();
    await expect(normalizeActionDraft(db, publishDraft(), [{ id: 'q1', rows: [{ workflow_id: 12, row_number: 1 }] }]))
      .rejects.toThrow(/does not identify the target template/);
    await expect(normalizeActionDraft(db, publishDraft({ evidence: [] }), EVIDENCE)).rejects.toThrow(/does not identify the target template/);
    await expect(normalizeActionDraft(db, publishDraft({ migrate_in_flight: true }), EVIDENCE))
      .rejects.toThrow(/unsupported fields: migrate_in_flight/);
    await expect(normalizeActionDraft(db, publishDraft({ sequence_template_id: 0 }), EVIDENCE)).rejects.toThrow(/positive sequence_template_id/);

    process.env.CASEY_SEQUENCE_AUTHORING_ENABLED = '0';
    await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE)).rejects.toThrow(/Action kind is unavailable/);
  });

  test('a stored action type the card was not reviewed against refuses (fail closed)', async () => {
    const { db } = makeDb({ draftSteps: [sms(1, 'x'), { ...task(2), action_type: 'custom_code' }] });
    await expect(normalizeActionDraft(db, publishDraft(), EVIDENCE))
      .rejects.toThrow(/step 2 \(custom_code\) of a type Casey's publish card does not cover/);
  });
});

// ── Code-step inventory (A17.6's refusal, mode-scoped) ─────────────────────
// No sequence action type carries a runnable code body today. These pin the
// three facts that make that true, so a future code-bearing type or a
// code-running internal function fails HERE, loudly, instead of publishing.
describe('no sequence action type can carry runnable code — the inventory is pinned', () => {
  const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

  test('the card\'s reviewed action types equal the route\'s ALLOWED_ACTION_TYPES', () => {
    const route = /const ALLOWED_ACTION_TYPES\s*=\s*\[([^\]]*)\]/.exec(read('routes/sequences.js'));
    const card = /const SEQUENCE_PUBLISH_ACTION_TYPES = new Set\(\[([^\]]*)\]\)/.exec(read('services/assistantService.js'));
    const list = (m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(list(route)).toEqual(['email', 'internal_function', 'sms', 'start_workflow', 'task', 'webhook']);
    expect(list(card)).toEqual(list(route));
  });

  test('the engine pins the executeJob dispatch type LAST, so no stored row reaches custom_code', () => {
    const src = read('lib/sequenceEngine.js');
    expect(src).toMatch(/const jobData = \{\s*\.\.\.resolvedConfig,\s*type: 'internal_function'\s*\};/);
  });

  test('no internal function runs a code body (none loads a code runner or vm)', () => {
    const dir = path.join(REPO, 'lib', 'internal_functions');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect({ f, runner: /require\([^)]*(?:customCodeRunner|safeCodeRunner|guestCode|job_executor|['"](?:node:)?vm['"])[^)]*\)/.test(src) })
        .toEqual({ f, runner: false });
      expect({ f, newFunction: /new Function\(/.test(src) }).toEqual({ f, newFunction: false });
    }
  });
});

// ── The route precondition, and end to end through the shipped builder ─────
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

function sendToRoute(db, request) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.db = db; next(); });
  a.use(require('../routes/sequences.js'));
  const data = JSON.stringify(request.body);
  return new Promise((resolve, reject) => {
    const server = a.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: request.path, method: request.method,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
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

describe('POST /sequences/templates/:id/publish expected_base precondition', () => {
  const base = () => ({ draft_version: 4, step_count: 3, draft_fingerprint: sequenceDraftFingerprint(DRAFT_STEPS, COND) });
  const publish = (db, expected_base) => sendToRoute(db,
    { path: '/sequences/templates/12/publish', method: 'POST', body: expected_base === undefined ? {} : { expected_base } });
  const condReads = (state) => state.reads.filter((sql) => /sequence_template_versions WHERE template_id = \? AND version = \?/.test(sql));

  test('absent expected_base publishes as before, reading no condition; a matching base publishes too', async () => {
    const a = makeDb();
    const r = await publish(a.db);
    expect({ status: r.status, published: r.body.published_version, migrated: r.body.migrated_count })
      .toEqual({ status: 200, published: 4, migrated: null });
    expect(a.state.writes.some((w) => /UPDATE sequence_templates SET current_version/.test(w))).toBe(true);
    expect(condReads(a.state)).toEqual([]);
    const b = makeDb();
    expect((await publish(b.db, base())).status).toBe(200);
    expect(condReads(b.state)).toHaveLength(1);
    // A base without a fingerprint checks version + count only, still no condition read.
    const c = makeDb();
    expect((await publish(c.db, { draft_version: 4, step_count: 3 })).status).toBe(200);
    expect(condReads(c.state)).toEqual([]);
  });

  test('draft_version, step_count and draft_fingerprint mismatches each 409 with nothing written', async () => {
    for (const [field, bad] of [
      ['draft_version', { ...base(), draft_version: 5 }],
      ['step_count', { ...base(), step_count: 2 }],
      ['draft_fingerprint', { ...base(), draft_fingerprint: 'a'.repeat(64) }],
    ]) {
      const { db, state } = makeDb();
      const r = await publish(db, bad);
      expect({ field, status: r.status, changed: r.body.conflict && r.body.conflict.changed })
        .toEqual({ field, status: 409, changed: field });
      expect(r.body.error).toMatch(/changed since it was reviewed/);
      expect(state.writes).toEqual([]);
    }
  });

  test('a step edit after the review changes the fingerprint and is refused', async () => {
    const { db, state } = makeDb();
    state.draftSteps[0] = sms(1, 'EDITED after review');
    const r = await publish(db, base());
    expect({ status: r.status, changed: r.body.conflict.changed }).toEqual({ status: 409, changed: 'draft_fingerprint' });
    expect(state.writes).toEqual([]);
  });

  test('a template-condition edit after the review (no step touched) is refused', async () => {
    const { db, state } = makeDb();
    state.conds[4] = JSON.stringify({ ...COND, assert: { appt_status: 'Canceled' } });
    const r = await publish(db, base());
    expect({ status: r.status, changed: r.body.conflict.changed }).toEqual({ status: 409, changed: 'draft_fingerprint' });
    expect(state.writes).toEqual([]);
  });

  test('the fingerprint is key-order-insensitive (MySQL re-orders JSON keys on write)', async () => {
    const { db, state } = makeDb();
    state.draftSteps[0] = { ...state.draftSteps[0],
      action_config: { params: { message: 'We missed you today', to: '{{contacts.contact_phone}}', from: '2484179800' }, function_name: 'send_sms' } };
    state.conds[4] = { assert: COND.assert, params: COND.params, query: COND.query };
    expect((await publish(db, base())).status).toBe(200);
  });

  test.each([
    ['not an object', 'x'],
    ['unknown key', { draft_version: 4, step_count: 3, step_fingerprint: 'a'.repeat(64) }],
    ['null draft_version', { draft_version: null, step_count: 3 }],
    ['negative step_count', { draft_version: 4, step_count: -1 }],
    ['malformed fingerprint', { draft_version: 4, step_count: 3, draft_fingerprint: 'zz' }],
  ])('bad shape (%s) is a 400 before the transaction', async (_n, bad) => {
    const { db, state } = makeDb();
    const r = await publish(db, bad);
    expect(r.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.reads).toEqual([]);
  });
});

describe('end to end: the shipped publish builder against the real route', () => {
  const html = fs.readFileSync(path.join(REPO, 'public', 'assistant.html'), 'utf8');
  // eslint-disable-next-line no-new-func
  const buildRequest = new Function(`${fnSrc(html, 'sequencePublishRequest')}; return sequencePublishRequest;`)();

  test('the card publishes; migrate_in_flight is pinned false, so no enrollment is repointed', async () => {
    const norm = makeDb();
    const card = await normalizeActionDraft(norm.db, publishDraft(), EVIDENCE);
    const request = buildRequest(card);
    expect(request).toEqual({ path: '/sequences/templates/12/publish', method: 'POST',
      body: { migrate_in_flight: false, expected_base: card.expected_base }, idempotent: false });
    const route = makeDb();
    const r = await sendToRoute(route.db, request);
    expect({ status: r.status, published: r.body.published_version, migrated: r.body.migrated_count })
      .toEqual({ status: 200, published: 4, migrated: null });
    expect(route.state.writes.some((w) => /UPDATE sequence_enrollments/.test(w))).toBe(false);
  });

  test('a stale card — a step appended after review — is refused by the route', async () => {
    const norm = makeDb();
    const card = await normalizeActionDraft(norm.db, publishDraft(), EVIDENCE);
    const route = makeDb();
    route.state.draftSteps.push(task(4));
    const r = await sendToRoute(route.db, buildRequest(card));
    expect({ status: r.status, changed: r.body.conflict.changed }).toEqual({ status: 409, changed: 'step_count' });
    expect(route.state.writes).toEqual([]);
  });

  test('the step fingerprint helper is the one the fingerprint is built from', () => {
    // sequenceDraftFingerprint must hash sequenceStepFingerprint, not a second
    // step identity: equal step content at the same positions → equal hash
    // regardless of extra columns the row happens to carry.
    const withIds = DRAFT_STEPS.map((s, i) => ({ ...s, id: 900 + i, template_id: 12, version: 4 }));
    expect(sequenceDraftFingerprint(withIds, COND)).toBe(sequenceDraftFingerprint(DRAFT_STEPS, JSON.stringify(COND)));
    expect(sequenceStepFingerprint(withIds[0])).toBe(sequenceStepFingerprint(DRAFT_STEPS[0]));
  });
});
