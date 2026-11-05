// tests/campaignC7.test.js
//
/**
 * YisraMail C7 — the DB-free half (ref/YISRAMAIL_DESIGN.md §9 row C7):
 *   M  send_email's meta: the new params exist with the right shapes, `from`
 *      is conditionally required (run-time), the body trio includes
 *      design_id, and — a security pin — ctaInputParams is EXACTLY the C-TA
 *      reviewed set (to, subject, html): none of the C7 params may become a
 *      clicker input without a deliberate review (ref/CTA_DESIGN.md §12)
 *   R  refusals that need no engine: sms promotional (D1), promotional
 *      without topic, promotional with include_signature, design_id without
 *      contact_id — each BEFORE any DB i/o (poisoned db proves it)
 * The send paths run on the real engine: tests/campaignC7.mysql.test.js.
 */
'use strict';

const fns = require('../lib/internal_functions');

/** A db that fails the test the moment anything touches it. */
const poisonedDb = { query: () => { throw new Error('db must not be touched'); } };

describe('send_email meta (C7)', () => {
  const meta = fns.send_email.__meta;
  const spec = (n) => meta.params.find((p) => p.name === n);

  test('the C7 params exist with the right shapes; from is no longer save-required', () => {
    expect(spec('from')).toMatchObject({ required: false, widget: 'email_from' });
    expect(spec('promotional')).toMatchObject({ type: 'boolean', required: false, default: false });
    expect(spec('topic')).toMatchObject({ type: 'string', required: false });
    expect(spec('marketing_sender')).toMatchObject({ type: 'string', required: false });
    expect(spec('design_id')).toMatchObject({ type: 'integer', required: false, widget: 'email_design' });
    expect(spec('contact_id')).toMatchObject({ type: 'integer', required: false, placeholderAllowed: true });
  });

  test('the body trio: at least one of text / html / design_id', () => {
    expect(meta.requiredWith).toEqual([['text', 'html', 'design_id']]);
  });

  test('SECURITY PIN — ctaInputParams is exactly the reviewed set; no C7 param is a clicker input', () => {
    expect(Object.keys(meta.ctaInputParams).sort()).toEqual(['html', 'subject', 'to']);
  });

  test('send_sms carries the promotional param (refused at run, D1) and its own inputs pin', () => {
    const s = fns.send_sms.__meta.params.find((p) => p.name === 'promotional');
    expect(s).toMatchObject({ type: 'boolean', required: false, default: false });
    expect(Object.keys(fns.send_sms.__meta.ctaInputParams || {})).not.toContain('promotional');
  });
});

describe('refusals before any i/o', () => {
  test("sms promotional is refused loudly (D1), truthy strings included — the db is never touched", async () => {
    for (const v of [true, 'true', '1', 'yes']) {
      await expect(fns.send_sms({ from: '2485559999', to: '3135550002', message: 'hi', promotional: v }, poisonedDb))
        .rejects.toThrow(/D1/);
    }
  });

  test('promotional needs a topic; include_signature is refused on promotional (the footer is the sign-off)', async () => {
    await expect(fns.send_email({ to: 'x@y.test', subject: 's', html: '<p>x</p>', promotional: true, contact_id: 2 }, poisonedDb))
      .rejects.toThrow(/requires topic/);
    await expect(fns.send_email({ to: 'x@y.test', subject: 's', html: '<p>x</p>', promotional: true, topic: 'newsletter', contact_id: 2, include_signature: true }, poisonedDb))
      .rejects.toThrow(/include_signature does not apply/);
  });

  test('design_id without a usable contact_id is refused before the design is even read', async () => {
    for (const cid of [undefined, null, '', 0, -1, 'abc']) {
      await expect(fns.send_email({ from: 'ops@firm.test', to: 'x@y.test', subject: 's', design_id: 5, contact_id: cid }, poisonedDb))
        .rejects.toThrow(/contact_id/);
    }
  });

  test('the operational contract is untouched: from still required when not promotional', async () => {
    await expect(fns.send_email({ to: 'x@y.test', subject: 's', html: '<p>x</p>' }, poisonedDb))
      .rejects.toThrow(/requires from/);
  });
});

// ─── The D13 writer gate (review B1) ─────────────────────────

describe('promotionalSendGate', () => {
  const gate = require('../lib/promotionalSendGate');
  const STAFF = { type: 'jwt', roles: ['staff'], userId: 9 };
  const ADMIN = { type: 'jwt', roles: ['admin'], userId: 6 };

  test('literal falsy passes ungated; anything else — true in any spelling or a placeholder — needs campaigns.bulk', () => {
    for (const v of [undefined, null, '', false, 'false', '0', 0]) {
      expect(gate.refusePromotionalWithoutCapability(STAFF, 'send_email', { promotional: v })).toBeNull();
    }
    for (const v of [true, 'true', '1', 1, 'yes', '{{v}}', 'maybe']) {
      const r = gate.refusePromotionalWithoutCapability(STAFF, 'send_email', { promotional: v });
      expect(r).toMatchObject({ status: 403 });
      expect(gate.refusePromotionalWithoutCapability(ADMIN, 'send_email', { promotional: v })).toBeNull();
    }
    expect(gate.refusePromotionalWithoutCapability(STAFF, 'send_sms', { promotional: true })).toBeNull();     // D1 refuses at run, whoever asks
    expect(gate.refusePromotionalWithoutCapability(STAFF, 'lookup_contact', { promotional: true })).toBeNull();
    expect(gate.refusePromotionalWithoutCapability(STAFF, 'send_email', undefined)).toBeNull();
  });

  test("the step shape gates EVERY function-carrying type — sequences run 'email'/'sms'/'task' as internal functions (re-review B1a); the mapping shape gates the KEY (values are dispatch-time)", () => {
    for (const t of ['internal_function', 'email', 'sms', 'task']) {
      expect(gate.refusePromotionalStep(STAFF, t, { function_name: 'send_email', params: { promotional: true } })).toMatchObject({ status: 403 });
      expect(gate.refusePromotionalStep(ADMIN, t, { function_name: 'send_email', params: { promotional: true } })).toBeNull();
    }
    expect(gate.refusePromotionalStep(STAFF, 'custom_code', { code: 'x' })).toBeNull();
    expect(gate.refusePromotionalStep(STAFF, 'webhook', { function_name: 'send_email', params: { promotional: true } })).toBeNull();
    expect(gate.refusePromotionalStep(STAFF, 'internal_function', null)).toBeNull();
    expect(gate.refusePromotionalMapping(STAFF, 'send_email', { promotional: 'body.flag' })).toMatchObject({ status: 403 });
    expect(gate.refusePromotionalMapping(STAFF, 'send_email', { to: 'body.email' })).toBeNull();
    expect(gate.refusePromotionalMapping(ADMIN, 'send_email', { promotional: 'body.flag' })).toBeNull();
    expect(gate.refusePromotionalMapping(STAFF, 'create_task', { promotional: 'body.flag' })).toBeNull();
    // Ingest shapes (re-review B1b): one action, and a rule's inline list.
    const act = { action_type: 'internal_function', config: { function_name: 'send_email', params_mapping: { promotional: "'true'" } } };
    expect(gate.refusePromotionalIngestAction(STAFF, act)).toMatchObject({ status: 403 });
    expect(gate.refusePromotionalIngestAction(ADMIN, act)).toBeNull();
    expect(gate.refusePromotionalIngestAction(STAFF, { action_type: 'workflow', config: {} })).toBeNull();
    expect(gate.refusePromotionalIngestRule(STAFF, { actions: [{ action_type: 'task', config: {} }, act] })).toMatchObject({ status: 403 });
    expect(gate.refusePromotionalIngestRule(STAFF, { actions: [] })).toBeNull();
    expect(gate.refusePromotionalIngestRule(STAFF, {})).toBeNull();
  });

  test('an action UPDATE gates the MERGED stored+body action — the round-3 type-flip bypass is closed', () => {
    // Step 1 of the bypass: a workflow-type action smuggles the mapping (its
    // config keeps extra keys). Step 2: flip the type with NO config.
    const smuggled = { action_type: 'workflow',
      config: JSON.stringify({ workflow_id: 27, function_name: 'send_email', params_mapping: { promotional: "'true'", topic: "'newsletter'" } }) };
    expect(gate.refusePromotionalIngestActionUpdate(STAFF, smuggled, { action_type: 'internal_function' })).toMatchObject({ status: 403 });
    expect(gate.refusePromotionalIngestActionUpdate(ADMIN, smuggled, { action_type: 'internal_function' })).toBeNull();
    // A config-only update onto a stored internal_function row gates too…
    const fnRow = { action_type: 'internal_function', config: { function_name: 'send_email', params_mapping: {} } };
    expect(gate.refusePromotionalIngestActionUpdate(STAFF, fnRow,
      { config: { function_name: 'send_email', params_mapping: { promotional: "'true'" } } })).toMatchObject({ status: 403 });
    // …and innocent updates pass.
    expect(gate.refusePromotionalIngestActionUpdate(STAFF, fnRow, { config: { function_name: 'send_email', params_mapping: { to: 'body.email' } } })).toBeNull();
    expect(gate.refusePromotionalIngestActionUpdate(STAFF, { action_type: 'task', config: {} }, { position: 2 })).toBeNull();
  });

  test('WIRING PIN — every writer calls the gate, exactly as counted (a dropped call site is a reopened B1)', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    expect(read('routes/workflows.js').match(/refusePromotionalStep\(req\.auth/g)).toHaveLength(5);
    expect(read('routes/sequences.js').match(/refusePromotionalStep\(req\.auth/g)).toHaveLength(3);
    expect(read('routes/scheduled_jobs.js').match(/refusePromotionalWithoutCapability\(req\.auth/g)).toHaveLength(2);
    expect(read('routes/api.triggers.js').match(/refusePromotionalActions\(req\.auth/g)).toHaveLength(2);
    expect(read('routes/api.hooks.js').match(/refusePromotionalTarget\(req\.auth/g)).toHaveLength(2);
    expect(read('routes/api.hooks.js').match(/refusePromotionalMapping\(req\.auth/g)).toHaveLength(1);
    // The target UPDATE judges the MERGED stored+body target (round 3) — the
    // SELECT is the merge's anchor.
    expect(read('routes/api.hooks.js').match(/SELECT target_type, config FROM hook_targets WHERE id = \?/g)).toHaveLength(1);
    expect(read('services/stepPreviewService.js').match(/refusePromotionalStep\(auth/g)).toHaveLength(1);
    for (const rf of ['routes/api.emailIngest.js', 'routes/api.phoneIngest.js']) {
      expect(read(rf).match(/refusePromotionalIngestRule\(req\.auth/g)).toHaveLength(1);        // rules POST, inline actions
      expect(read(rf).match(/refusePromotionalIngestAction\(req\.auth/g)).toHaveLength(1);      // actions POST
      expect(read(rf).match(/refusePromotionalIngestActionUpdate\(req\.auth, before/g)).toHaveLength(1); // actions PUT — the MERGED action
    }
  });
});

// ─── Save-time from (requiredUnless) ─────────────────────────

describe('from is save-required unless promotional is the literal true', () => {
  const validate = (params) => fns.__validateFunctionParams('send_email', params);

  test('an operational step without from is refused at SAVE, not at run', () => {
    const v = validate({ to: 'x@y.test', subject: 's', html: '<p>x</p>' });
    expect(v).toBeTruthy();
    expect(v.error).toMatch(/from is required \(unless promotional is on\)/);
  });

  test('promotional literal true waives it; a string or placeholder does NOT (stricter at save than at run)', () => {
    expect(validate({ to: 'x@y.test', subject: 's', html: '<p>x</p>', promotional: true, topic: 'newsletter', contact_id: 2 })).toBeNull();
    for (const v of ['true', '{{v}}']) {
      const r = validate({ to: 'x@y.test', subject: 's', html: '<p>x</p>', promotional: v, topic: 'newsletter', contact_id: 2 });
      expect(r && r.error).toMatch(/from is required/);
    }
    expect(validate({ from: 'ops@firm.test', to: 'x@y.test', subject: 's', html: '<p>x</p>' })).toBeNull();
  });
});

// ─── Casey's taught params ───────────────────────────────────

describe('Casey is taught promotional but never design_id', () => {
  test('the prompt line: promotional/topic/marketing_sender taught; design_id and attachment_urls filtered', () => {
    const path = require('path');
    const system = require(path.join(__dirname, '..', 'lib', 'aiPrompts', 'assistantAnswer')).system;
    const line = system.split('\n').find((l) => /^  send_email \(external-send\)/.test(l));
    expect(line).toMatch(/promotional\?:boolean/);
    expect(line).toMatch(/topic\?:string/);
    expect(line).toMatch(/marketing_sender\?:string/);
    expect(line).not.toMatch(/design_id/);
    expect(line).not.toMatch(/attachment_urls/);
  });
});
