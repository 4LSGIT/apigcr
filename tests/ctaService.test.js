// tests/ctaService.test.js
//
/**
 * CTA substrate (CTA arc S1) — services/ctaService.js, ref/CTA_DESIGN.md.
 *
 * WHAT IS LOCKED (spec §10 S1 list, plus the invariants in the service header)
 *   - Eligibility: the exact eligible-function set (a reviewed exposure
 *     decision — update EXPECTED_ELIGIBLE deliberately), predicate +
 *     denylist cases, prototype-chain names, run-time re-check.
 *   - Runtime guard: a step returning delayed_until / next_step fails the plan.
 *   - Once-claim race, repeatable max_uses race (gated: every racer has
 *     passed the JS pre-check before any UPDATE is evaluated).
 *   - Password verified BEFORE the claim and BEFORE the increment.
 *   - Timeout: claim-before-plan, double-run attempt, by=0, kill switch.
 *   - Running-row lifecycle: the row exists (and the link is claimed) while
 *     a plan is mid-flight; stale running rows warn once.
 *   - PATCH: re-enable resets uses_count (and revives the timeout claim),
 *     latest-must-have-failed, cancelled permanent, status-guarded write.
 *   - result_template: render, escaping, unknown-step mint throw, full
 *     (untruncated) outputs; raw plan_result only for return_plan_result.
 *
 * HARNESS: the REAL ctaService and REAL registry functions (lookup_contact,
 * noop, start_workflow's validator …) against tests/helpers/ctaWorld.js — a
 * stateful in-memory DB that EVALUATES each guarded UPDATE's own SET/WHERE
 * text, so weakening the SQL changes the outcome. Only the alert sink is
 * mocked (alert() would otherwise try to send email).
 *
 * Run: npx jest tests/ctaService.test.js
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));

const bcrypt = require('bcrypt');
const cta = require('../services/ctaService');
const registry = require('../lib/internal_functions');
const { alert } = require('../lib/alerting');
const { makeCtaWorld, decodeLog } = require('./helpers/ctaWorld');

const SU = 6;          // 'authorized - SU' in the world
const NON_SU = 22;     // 'authorized'
const HOUR = 3600e3;
const DAY = 24 * HOUR;

let db;
let W;

// A gate or hook whose regex never matched would leave its test "passing"
// without ever staging the race / interleaving it exists for. Fail that.
afterEach(() => {
  for (const g of W.gates) expect({ gate: String(g.re), opened: g.open }).toEqual({ gate: String(g.re), opened: true });
  for (const h of W.hooks) expect({ hook: String(h.re), fired: h.hits > 0 }).toEqual({ hook: String(h.re), fired: true });
});

beforeEach(() => {
  db = makeCtaWorld();
  W = db.W;
  W.contacts.set(1001, {
    contact_id: 1001, contact_name: 'Pat Doe', contact_email: 'pat@example.com',
    contact_notes: 'short', contact_dob: null,
  });
  alert.mockClear();
});

function baseMint(over = {}) {
  return {
    name: 'Mark lead as spam',
    prompt: 'Is this lead spam?',
    minted_by: SU,
    options: [
      { value: 'spam', label: 'Mark as spam', plan: [{ fn: 'lookup_contact', params: { contact_id: '1001' } }] },
    ],
    ...over,
  };
}

const LOOKUP = (id = '1001') => ({ fn: 'lookup_contact', params: { contact_id: id } });

async function expect400(p, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(cta.CtaError);
  expect(err.status).toBe(400);
  if (re) expect(err.message).toMatch(re);
  return err;
}

async function expectStatus(p, status, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(cta.CtaError);
  expect(err.status).toBe(status);
  if (re) expect(err.message).toMatch(re);
  return err;
}

const contactsReads = () => W.queries.filter((q) => /FROM contacts WHERE contact_id = \?/.test(q.sql)).length;
const ctaAlerts = () => alert.mock.calls.map((c) => c[1]).filter((a) => a.source === 'cta');

// ═════════════════════════════════════════════════════════════════════════════
// Eligibility (§4 B2)
// ═════════════════════════════════════════════════════════════════════════════

// Every registry addition is an exposure decision: a new function lands here
// only by someone editing this list on purpose. Rejected today (25 of 111
// raw keys): the 14 __-prefixed module exports/self-adds, the 6 controlFlow
// functions, and the 4 denylisted: wait_until_time (§4.2) plus the S2
// ruling's cta_expiry_sweep, decision_timeout_cleanup, set_test_var.
const EXPECTED_ELIGIBLE = [
  'advance_stage', 'ai_match', 'business_deadline', 'cancel_case_appointments',
  'cancel_sequences', 'cancel_workflow_execution', 'complete_event',
  'court_activity_summary', 'court_extract', 'court_review_retry',
  'create_appointment', 'create_event', 'create_log', 'create_task',
  'document_generate_from_template',
  'documents_attribution_report', 'documents_refresh_case_cache', 'documents_sync',
  'dropbox_create_folder', 'dropbox_delete', 'dropbox_ensure_case_folder',
  'dropbox_get_shared_link', 'dropbox_list_folder', 'dropbox_move', 'dropbox_rename',
  'dropbox_save_url', 'emit_calendar_approaching', 'emit_stage_aged', 'enroll_sequence',
  'esign_get_status', 'esign_recall', 'esign_reconcile', 'esign_remind',
  'esign_send_from_template', 'find_contact', 'find_live_calendar_item', 'format_string',
  'forward_as_email', 'forward_as_sms', 'gcal_create_event', 'gcal_delete_event',
  'gcal_get_event', 'gcal_update_event', 'gcontacts_sync_pending', 'generate_firm_blocks',
  'get_appointments', 'get_events', 'get_setting', 'get_settings', 'insert_db',
  'intake_case', 'intake_contact', 'list_users', 'lookup_appointment', 'lookup_contact',
  'lookup_event', 'lookup_user', 'noop', 'parse_pdf', 'phone_log',
  'portal_callback_reminder', 'query_ai', 'query_db', 'rc_renew_subscriptions',
  'refresh_expiring_oauth_credentials', 'render_submission_pdf', 'report_email',
  'run_error_sweep', 'run_event_digest', 'run_task_digest', 'send_email', 'send_mms',
  'send_sms', 'set_log_about', 'set_setting', 'set_var', 'start_workflow',
  'sweep_calendar_missed', 'sweep_trigger_executions', 'update_appointment', 'update_case',
  'update_contact', 'update_db', 'update_event', 'update_log', 'validate_case_trustee',
];

describe('eligibility — layered filter (§4)', () => {
  test('the eligible set is exactly the reviewed snapshot', () => {
    expect(cta.eligibleFunctionNames()).toEqual(EXPECTED_ELIGIBLE);
  });

  test('predicate + denylist cases', () => {
    // workflowOnly is NOT a filter (§4.6)
    expect(registry.start_workflow.__meta.workflowOnly).toBe(true);
    expect(cta.isCtaEligible('start_workflow')).toBe(true);
    // the seeded denylist (+ the S2 ruling's three)
    expect(cta.CTA_FN_DENYLIST).toEqual(['wait_until_time', 'cta_expiry_sweep', 'decision_timeout_cleanup', 'set_test_var', 'create_cta']);
    expect(registry.wait_until_time.__meta.controlFlow).toBeUndefined(); // flagless by design
    expect(cta.isCtaEligible('wait_until_time')).toBe(false);
    // S2 ruling: each is a real meta-bearing registry function that ONLY the
    // denylist keeps out (so dropping one from the list re-exposes it).
    for (const f of ['cta_expiry_sweep', 'decision_timeout_cleanup', 'set_test_var']) {
      expect(typeof registry[f]).toBe('function');
      expect(registry[f].__meta).toBeTruthy();
      expect(registry[f].__meta.controlFlow).not.toBe(true);
      expect(cta.isCtaEligible(f)).toBe(false);
    }
    // __-prefixed registry members — plain data and helper functions alike
    expect(cta.isCtaEligible('__WRITE_POLICY')).toBe(false);
    expect(typeof registry.__validateFunctionParams).toBe('function');
    expect(cta.isCtaEligible('__validateFunctionParams')).toBe(false);
    // controlFlow functions (engine-coupled)
    for (const f of ['set_next', 'evaluate_condition', 'foreach', 'request_decision', 'wait_for', 'schedule_resume']) {
      expect(registry[f].__meta.controlFlow).toBe(true);
      expect(cta.isCtaEligible(f)).toBe(false);
    }
    // junk
    for (const f of ['', 'no_such_fn', null, undefined, 42]) expect(cta.isCtaEligible(f)).toBe(false);
  });

  test('a __-prefixed function stays denied even if it carries __meta', () => {
    // Today no __ member has meta (so the meta check alone would hide them);
    // the prefix rule must hold on its own for the next self-add that does.
    registry.__cta_probe = Object.assign(async () => ({ success: true }), {
      __meta: { category: 'dev', description: 'probe', params: [] },
    });
    try {
      expect(cta.isCtaEligible('__cta_probe')).toBe(false);
      expect(cta.eligibleFunctionNames()).not.toContain('__cta_probe');
    } finally {
      delete registry.__cta_probe;
    }
  });

  test('prototype-chain names never resolve (own-property lookup)', () => {
    // A polluted prototype carrying a meta-bearing function must not make a
    // name eligible through the registry's prototype chain.
    const probe = Object.assign(async () => ({ success: true }), {
      __meta: { category: 'dev', description: 'probe', params: [] },
    });
    // eslint-disable-next-line no-extend-native
    Object.defineProperty(Object.prototype, 'cta_proto_probe', { value: probe, configurable: true, writable: true });
    try {
      expect(registry.cta_proto_probe).toBe(probe);           // reachable via the chain…
      expect(cta.isCtaEligible('cta_proto_probe')).toBe(false); // …but not eligible
      expect(cta.isCtaEligible('constructor')).toBe(false);
    } finally {
      delete Object.prototype.cta_proto_probe;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Mint validation
// ═════════════════════════════════════════════════════════════════════════════

describe('mint validation', () => {
  test('a valid mint inserts one active row and returns the token', async () => {
    const r = await cta.mintCta(db, baseMint());
    expect(r.dry_run).toBe(false);
    expect(r.token).toMatch(/^[0-9A-Za-z]{22}$/);
    const row = W.link(r.id);
    expect(row.status).toBe('active');
    expect(row.mode).toBe('once');
    expect(row.mint_source).toBe('su');
    expect(row.minted_by).toBe(SU);
    expect(JSON.parse(row.options)[0].plan).toEqual([LOOKUP()]);
    expect(r.password).toBeUndefined();
    expect(row.protection).toBe('none');
  });

  test('rejects _-prefixed param keys (engine-injection namespace)', async () => {
    await expect400(cta.mintCta(db, baseMint({
      options: [{ value: 'x', label: 'X', plan: [{ fn: 'cancel_workflow_execution', params: { execution_id: '5', reason: 'abc', _execution_id: 5 } }] }],
    })), /_-prefixed keys are reserved/);
    expect(W.tables.cta_links.size).toBe(0);
  });

  test('rejects any unresolved {{...}} — nested values too', async () => {
    await expect400(cta.mintCta(db, baseMint({
      options: [{ value: 'rerun', label: 'Re-run intake', plan: [{
        fn: 'start_workflow',
        params: { workflow_id: '27', init_data: { lead: { name: 'ok', email: '{{email}}' } } },
      }] }],
    })), /options\[0\]\.plan\[0\]\.params\.init_data\.lead\.email: unresolved \{\{/);
    await expect400(cta.mintCta(db, baseMint({ options: [{ value: 'a', label: 'A', plan: [LOOKUP('{{cid}}')] }] })), /unresolved/);
  });

  test('runs __validateFunctionParams per step — dry_run included', async () => {
    const bad = baseMint({ options: [{ value: 'a', label: 'A', plan: [LOOKUP(), { fn: 'lookup_contact', params: {} }] }] });
    await expect400(cta.mintCta(db, bad), /plan\[1\] \(lookup_contact\): contact_id is required/);
    await expect400(cta.mintCta(db, { ...bad, dry_run: true }), /contact_id is required/);
  });

  test('rejects ineligible functions with a reason', async () => {
    const one = (fn) => baseMint({ options: [{ value: 'a', label: 'A', plan: [{ fn, params: {} }] }] });
    await expect400(cta.mintCta(db, one('wait_until_time')), /denied for CTA plans/);
    await expect400(cta.mintCta(db, one('set_next')), /workflow control function/);
    await expect400(cta.mintCta(db, one('__WRITE_POLICY')), /unknown function/);
    await expect400(cta.mintCta(db, one('nope')), /unknown function "nope"/);
  });

  test('option rules: 1–10, unique, url-safe, "respond" reserved, plan 1–20', async () => {
    const opt = (value) => ({ value, label: value, plan: [LOOKUP()] });
    await expect400(cta.mintCta(db, baseMint({ options: [] })), /1–10 options/);
    await expect400(cta.mintCta(db, baseMint({ options: Array.from({ length: 11 }, (_, i) => opt(`o${i}`)) })), /1–10 options/);
    expect((await cta.mintCta(db, baseMint({ options: Array.from({ length: 10 }, (_, i) => opt(`o${i}`)) }))).options).toHaveLength(10);
    await expect400(cta.mintCta(db, baseMint({ options: [opt('respond')] })), /"respond" is reserved/);
    await expect400(cta.mintCta(db, baseMint({ options: [opt('a'), opt('a')] })), /duplicate option value/);
    await expect400(cta.mintCta(db, baseMint({ options: [opt('a b')] })), /url-safe/);
    await expect400(cta.mintCta(db, baseMint({ options: [{ value: 'a', label: 'A', plan: [] }] })), /1–20/);
    await expect400(cta.mintCta(db, baseMint({ options: [{ value: 'a', label: 'A', plan: Array.from({ length: 21 }, () => LOOKUP()) }] })), /1–20/);
  });

  test('unknown fields are rejected at every level (typos fail loudly)', async () => {
    await expect400(cta.mintCta(db, baseMint({ expire_at: '2026-12-01' })), /unknown field "expire_at"/);
    await expect400(cta.mintCta(db, baseMint({ options: [{ value: 'a', label: 'A', plan: [LOOKUP()], template: 'x' }] })), /unknown field "template"/);
    await expect400(cta.mintCta(db, baseMint({ options: [{ value: 'a', label: 'A', plan: [{ fn: 'noop', params: {}, set_vars: {} }] }] })), /unknown field "set_vars"/);
  });

  test('timeout_option: once only, must name an option', async () => {
    await expect400(cta.mintCta(db, baseMint({ mode: 'repeatable', timeout_option: 'spam' })), /once only/);
    await expect400(cta.mintCta(db, baseMint({ timeout_option: 'ham' })), /not one of the option values/);
    const r = await cta.mintCta(db, baseMint({ timeout_option: 'spam' }));
    expect(W.link(r.id).timeout_option).toBe('spam');
  });

  test('max_uses: repeatable only, positive integer', async () => {
    await expect400(cta.mintCta(db, baseMint({ max_uses: 3 })), /repeatable only/);
    await expect400(cta.mintCta(db, baseMint({ mode: 'repeatable', max_uses: 0 })), /positive integer/);
    const r = await cta.mintCta(db, baseMint({ mode: 'repeatable', max_uses: 3 }));
    expect(W.link(r.id).max_uses).toBe(3);
  });

  test('expiry: settings defaults per mode, fallback on a bad setting, explicit timeout, bounds', async () => {
    const t0 = Date.now();
    const once = await cta.mintCta(db, baseMint());
    expect(Math.abs(new Date(once.expires_at).getTime() - (t0 + 3 * DAY))).toBeLessThan(5000);
    const rep = await cta.mintCta(db, baseMint({ mode: 'repeatable' }));
    expect(Math.abs(new Date(rep.expires_at).getTime() - (t0 + 30 * DAY))).toBeLessThan(5000);

    W.settings.set('cta_default_timeout_once', '7d');
    const tuned = await cta.mintCta(db, baseMint());
    expect(Math.abs(new Date(tuned.expires_at).getTime() - (t0 + 7 * DAY))).toBeLessThan(5000);

    W.settings.set('cta_default_timeout_once', 'soon-ish');
    const fallback = await cta.mintCta(db, baseMint());
    expect(Math.abs(new Date(fallback.expires_at).getTime() - (t0 + 3 * DAY))).toBeLessThan(5000);

    const explicit = await cta.mintCta(db, baseMint({ timeout: '2h' }));
    expect(Math.abs(new Date(explicit.expires_at).getTime() - (t0 + 2 * HOUR))).toBeLessThan(5000);

    await expect400(cta.mintCta(db, baseMint({ timeout: '366d' })), /exceeds 365d/);
    await expect400(cta.mintCta(db, baseMint({ expires_at: '2020-01-01T00:00:00Z' })), /in the future/);
    await expect400(cta.mintCta(db, baseMint({ timeout: '2h', expires_at: '2099-01-01' })), /not both/);
  });

  test('naive expires_at is firm time (America/Detroit), stored UTC', async () => {
    const day = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    const r = await cta.mintCta(db, baseMint({ expires_at: `${day}T09:00:00` }));
    // 09:00 Detroit is 13:00 (EDT) or 14:00 (EST) UTC — never 09:00.
    expect([13, 14]).toContain(new Date(r.expires_at).getUTCHours());
    expect(new Date(r.expires_at).toISOString().slice(0, 10)).toBe(day);
  });

  test('link_type follows the ABOUT_TYPES value set, normalized like about-links', async () => {
    await expect400(cta.mintCta(db, baseMint({ link_type: 'lead', link_id: '5' })), /Invalid about_type/);
    await expect400(cta.mintCta(db, baseMint({ link_type: 'contact' })), /go together/);
    const r = await cta.mintCta(db, baseMint({ link_type: 'phone', link_id: '+1 (248) 555-0100' }));
    expect(W.link(r.id).link_id).toBe('2485550100');
  });

  test('mint_source: su needs minted_by; workflow needs source_execution_id and minted_by 0', async () => {
    await expect400(cta.mintCta(db, baseMint({ minted_by: undefined })), /minted_by/);
    await expect400(cta.mintCta(db, baseMint({ mint_source: 'workflow', minted_by: undefined })), /source_execution_id is required/);
    await expect400(cta.mintCta(db, baseMint({ mint_source: 'workflow', minted_by: SU, source_execution_id: 9 })), /minted_by 0/);
    const r = await cta.mintCta(db, baseMint({ mint_source: 'workflow', minted_by: undefined, source_execution_id: 9 }));
    expect(W.link(r.id)).toMatchObject({ mint_source: 'workflow', minted_by: 0, source_execution_id: 9 });
  });

  test('attributed_user_id must exist', async () => {
    await expect400(cta.mintCta(db, baseMint({ attributed_user_id: 77 })), /not found/);
    const r = await cta.mintCta(db, baseMint({ attributed_user_id: NON_SU }));
    expect(W.link(r.id).attributed_user_id).toBe(NON_SU);
  });

  test('repeatable Chromium-backed plans warn', async () => {
    const r = await cta.mintCta(db, baseMint({ mode: 'repeatable', options: [{ value: 'pdf', label: 'PDF', plan: [{ fn: 'render_submission_pdf', params: { submission_id: 4 } }] }] }));
    expect(r.warnings.join(' ')).toMatch(/Chromium-backed render_submission_pdf/);
    const once = await cta.mintCta(db, baseMint({ options: [{ value: 'pdf', label: 'PDF', plan: [{ fn: 'render_submission_pdf', params: { submission_id: 4 } }] }] }));
    expect(once.warnings).toEqual([]);
  });
});

describe('mint — protection and passwords (§2.11, NB2)', () => {
  const tpl = { value: 'get_email', label: 'Show current email', plan: [LOOKUP()], result_template: 'Current email: [[1.output.contact_email]]' };

  test('result_template defaults protection to password with a one-time auto-generated 22-char base62 secret', async () => {
    const r = await cta.mintCta(db, baseMint({ options: [tpl] }));
    expect(r.protection).toBe('password');
    expect(r.protection_source).toBe('default_result_template');
    expect(r.notes.join(' ')).toMatch(/defaulted to 'password'/);
    expect(r.password).toMatch(/^[0-9A-Za-z]{22}$/);
    const row = W.link(r.id);
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);   // BCRYPT_ROUNDS=12
    expect(await bcrypt.compare(r.password, row.password_hash)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(r.password);   // never stored plaintext
  });

  test('explicit protection none overrides the default; no template → none', async () => {
    const r = await cta.mintCta(db, baseMint({ options: [tpl], protection: 'none' }));
    expect(r).toMatchObject({ protection: 'none', protection_source: 'explicit' });
    expect(r.password).toBeUndefined();
    expect(W.link(r.id).password_hash).toBeNull();
    const plain = await cta.mintCta(db, baseMint());
    expect(plain).toMatchObject({ protection: 'none', protection_source: 'default' });
  });

  test('SU-supplied secrets: ≥12 chars, ≤72 bytes, never echoed; contradiction with none is 400', async () => {
    await expect400(cta.mintCta(db, baseMint({ protection: 'password', password: 'short-11chr' })), /at least 12/);
    await expect400(cta.mintCta(db, baseMint({ protection: 'password', password: 'x'.repeat(73) })), /at most 72 bytes/);
    await expect400(cta.mintCta(db, baseMint({ protection: 'none', password: 'twelve-chars!' })), /protection is 'none'/);
    const r = await cta.mintCta(db, baseMint({ password: 'twelve-chars' }));
    expect(r).toMatchObject({ protection: 'password', protection_source: 'password_supplied' });
    expect(r.password).toBeUndefined();
    expect(await bcrypt.compare('twelve-chars', W.link(r.id).password_hash)).toBe(true);
  });

  test('dry_run validates fully, inserts nothing, mints no token or password', async () => {
    const r = await cta.mintCta(db, baseMint({ options: [tpl], dry_run: true }));
    expect(r.dry_run).toBe(true);
    expect(r.token).toBeUndefined();
    expect(r.password).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/password will be generated/);
    expect(W.tables.cta_links.size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// result_template (B5b)
// ═════════════════════════════════════════════════════════════════════════════

describe('result_template', () => {
  test('mint throws on an unknown step index (mirrors [[respond_url:X]]) and on malformed tokens', async () => {
    const o = (t, plan = [LOOKUP()]) => baseMint({ options: [{ value: 'a', label: 'A', plan, result_template: t }] });
    await expect400(cta.mintCta(db, o('Email: [[2.output.contact_email]]')), /unknown step 2 .*plan has 1 step\)/);
    await expect400(cta.mintCta(db, o('Email: [[0.output]]')), /unknown step 0/);
    await expect400(cta.mintCta(db, o('Email: [[contact_email]]')), /unsupported token \[\[contact_email\]\]/);
    await expect(cta.mintCta(db, o('[[2.output.contact_email]]', [LOOKUP(), LOOKUP()]))).resolves.toBeTruthy();
  });

  test('renders against step outputs, HTML-escaped; text stays raw for JSON', async () => {
    W.contacts.set(1001, {
      contact_id: 1001, contact_email: '<script>alert(1)</script>@x.com', contact_name: 'A & B',
      contact_dob: new Date('1980-02-03T00:00:00Z'),
    });
    const row = W.seedLink({
      protection: 'none',
      options: [{
        value: 'get', label: 'Get', plan: [LOOKUP()],
        result_template: 'Email: [[1.output.contact_email]]\nName: [[1.output.contact_name]]\nDOB: [[1.output.contact_dob]]\nGone: [[1.output.nope.deeper]]|',
      }],
    });
    const r = await cta.respond(db, { token: row.token, value: 'get' });
    expect(r).toMatchObject({ ok: true, status: 'success' });
    expect(r.result).toBe('Email: <script>alert(1)</script>@x.com\nName: A & B\nDOB: 1980-02-03T00:00:00.000Z\nGone: |');
    expect(r.result_html).toBe(
      'Email: &lt;script&gt;alert(1)&lt;/script&gt;@x.com<br>Name: A &amp; B<br>DOB: 1980-02-03T00:00:00.000Z<br>Gone: |'
    );
    expect(r.plan_result).toBeUndefined();   // return_plan_result=0 → no raw output
  });

  test('renders full (untruncated) outputs while plan_result is truncated ~2k/step', async () => {
    W.contacts.set(1001, { contact_id: 1001, contact_notes: 'n'.repeat(5000) });
    const row = W.seedLink({
      return_plan_result: 1,
      options: [{ value: 'get', label: 'Get', plan: [LOOKUP()], result_template: '[[1.output.contact_notes]]' }],
    });
    const r = await cta.respond(db, { token: row.token, value: 'get' });
    expect(r.result).toHaveLength(5000);
    const stored = W.execs(row.id)[0];
    const step = JSON.parse(stored.plan_result)[0];
    expect(typeof step.output).toBe('string');
    expect(step.output).toMatch(/…\[truncated \d+ chars\]$/);
    expect(step.output.length).toBeLessThan(cta.STEP_OUTPUT_MAX + 40);
    expect(r.plan_result[0].output).toBe(step.output);   // agent surface gets the stored (truncated) form
  });

  test('a failed plan never renders the template', async () => {
    const row = W.seedLink({
      options: [{ value: 'get', label: 'Get', plan: [LOOKUP('9999')], result_template: 'Email: [[1.output.contact_email]]' }],
    });
    const r = await cta.respond(db, { token: row.token, value: 'get' });
    expect(r).toMatchObject({ ok: true, status: 'failed' });
    expect(r.result).toBeUndefined();
    expect(r.result_html).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// respond — once
// ═════════════════════════════════════════════════════════════════════════════

describe('respond — mode once', () => {
  test('happy path: claim, running row in the claim transaction, success, one outcome log', async () => {
    const m = await cta.mintCta(db, baseMint({ attributed_user_id: NON_SU, link_type: 'contact', link_id: '1001' }));
    const r = await cta.respond(db, { token: m.token, value: 'spam', ip: '203.0.113.9' });
    expect(r).toEqual({ ok: true, status: 'success', execution_id: expect.any(Number) });

    const link = W.link(m.id);
    expect(link).toMatchObject({ status: 'used', uses_count: 1 });
    const [e] = W.execs(m.id);
    expect(e).toMatchObject({ status: 'success', option_value: 'spam', responded_via: 'link', responder_ip: '203.0.113.9' });
    expect(JSON.parse(e.plan_result)).toEqual([
      { fn: 'lookup_contact', ok: true, output: expect.objectContaining({ contact_id: 1001 }), ms: expect.any(Number) },
    ]);
    // claim + running-row insert share one transaction
    const claim = W.queries.find((q) => /^UPDATE cta_links SET status='used', uses_count=1/.test(q.sql));
    const ins = W.queries.find((q) => /^INSERT INTO cta_executions/.test(q.sql));
    expect(claim.inTxn).toBe(true);
    expect(ins.inTxn).toBe(true);

    expect(W.logs).toHaveLength(1);
    const log = decodeLog(W.logs[0]);
    expect(log).toMatchObject({ type: 'note', subject: 'CTA', by: NON_SU, link_type: 'contact', link_id: '1001' });
    expect(log.data).toMatchObject({ cta_id: m.id, cta_execution_id: e.id, option_value: 'spam', status: 'success', via: 'link' });

    // second click → terminal, no new execution
    expect(await cta.respond(db, { token: m.token, value: 'spam' })).toEqual({ ok: false, code: 'used' });
    expect(W.execs(m.id)).toHaveLength(1);
  });

  test('responder_user_id beats attributed_user_id in the log; neither → 0', async () => {
    const a = await cta.mintCta(db, baseMint({ attributed_user_id: NON_SU }));
    await cta.respond(db, { token: a.token, value: 'spam', via: 'app', responderUserId: SU });
    expect(decodeLog(W.logs[0]).by).toBe(SU);
    const b = await cta.mintCta(db, baseMint());
    await cta.respond(db, { token: b.token, value: 'spam' });
    expect(decodeLog(W.logs[1]).by).toBe(0);
  });

  test('ONCE-CLAIM RACE: two clicks past the pre-check, exactly one claim wins', async () => {
    const m = await cta.mintCta(db, baseMint());
    W.gate(/^UPDATE cta_links SET status='used', uses_count=1/, 2);
    const [a, b] = await Promise.all([
      cta.respond(db, { token: m.token, value: 'spam' }),
      cta.respond(db, { token: m.token, value: 'spam' }),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, code: 'used' });
    expect(W.execs(m.id)).toHaveLength(1);
    expect(contactsReads()).toBe(1);   // the plan ran once
  });

  test('PASSWORD BEFORE CLAIM: a wrong password burns nothing', async () => {
    const row = W.seedLink({ protection: 'password', password_hash: bcrypt.hashSync('correct horse battery', 4), options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    expect(await cta.respond(db, { token: row.token, value: 'go' })).toEqual({ ok: false, code: 'password_required' });
    expect(await cta.respond(db, { token: row.token, value: 'go', password: 'wrong' })).toEqual({ ok: false, code: 'bad_password' });
    expect(W.link(row.id)).toMatchObject({ status: 'active', uses_count: 0, failed_attempts: 1 });
    expect(W.execs(row.id)).toHaveLength(0);
    expect(W.queries.some((q) => /^UPDATE cta_links SET status='used'/.test(q.sql))).toBe(false);

    const ok = await cta.respond(db, { token: row.token, value: 'go', password: 'correct horse battery' });
    expect(ok).toMatchObject({ ok: true, status: 'success' });
    expect(W.link(row.id)).toMatchObject({ status: 'used', uses_count: 1 });
  });

  test('wrong-password alerts: warning at 20, error at 100, deduplicated per CTA, never disables', async () => {
    const row = W.seedLink({ protection: 'password', password_hash: bcrypt.hashSync('correct horse battery', 4), failed_attempts: 18, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    await cta.respond(db, { token: row.token, value: 'go', password: 'x' });   // 19
    expect(ctaAlerts()).toHaveLength(0);
    await cta.respond(db, { token: row.token, value: 'go', password: 'x' });   // 20
    expect(ctaAlerts()).toEqual([expect.objectContaining({
      severity: 'warning', group_key: `cta:${row.id}`, dedup_key: `cta:${row.id}:pw${cta.PW_WARN_AT}`,
    })]);
    W.link(row.id).failed_attempts = 98;
    await cta.respond(db, { token: row.token, value: 'go', password: 'x' });   // 99
    expect(ctaAlerts().filter((a) => a.severity === 'error')).toHaveLength(0);
    await cta.respond(db, { token: row.token, value: 'go', password: 'x' });   // 100
    expect(ctaAlerts().filter((a) => a.severity === 'error')).toEqual([expect.objectContaining({
      group_key: `cta:${row.id}`, dedup_key: `cta:${row.id}:pw${cta.PW_ERROR_AT}`,
    })]);
    expect(W.link(row.id).status).toBe('active');
  });

  test('B1 kill switch: an su mint whose minter is no longer SU refuses without claiming; workflow mints skip the check', async () => {
    const dead = W.seedLink({ minted_by: NON_SU, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    expect(await cta.respond(db, { token: dead.token, value: 'go' })).toEqual({ ok: false, code: 'minter_inactive' });
    expect(W.link(dead.id)).toMatchObject({ status: 'active', uses_count: 0 });
    expect(W.execs(dead.id)).toHaveLength(0);

    const wf = W.seedLink({ mint_source: 'workflow', minted_by: 0, source_execution_id: 77, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    expect(await cta.respond(db, { token: wf.token, value: 'go' })).toMatchObject({ ok: true, status: 'success' });
  });

  test('terminal and invalid states never claim', async () => {
    const opts = [{ value: 'go', label: 'Go', plan: [LOOKUP()] }];
    const cases = [
      [W.seedLink({ status: 'disabled', options: opts }), 'disabled'],
      [W.seedLink({ status: 'cancelled', options: opts }), 'cancelled'],
      [W.seedLink({ expires_at: new Date(Date.now() - 1000), options: opts }), 'expired'],
    ];
    for (const [row, code] of cases) {
      expect(await cta.respond(db, { token: row.token, value: 'go' })).toEqual({ ok: false, code });
    }
    const live = W.seedLink({ options: opts });
    expect(await cta.respond(db, { token: live.token, value: 'nope' })).toEqual({ ok: false, code: 'unknown_option' });
    expect(await cta.respond(db, { token: 'missing-token-xyz', value: 'go' })).toEqual({ ok: false, code: 'not_found' });
    expect(W.execs()).toHaveLength(0);
    await expect(cta.respond(db, { token: live.token, value: 'go', via: 'timeout' })).rejects.toThrow(/invalid via/);
  });

  test('failed plan: execution failed, link stays used, error alert grouped cta:<id>, generic outcome', async () => {
    const row = W.seedLink({ name: 'Bad lookup', options: [{ value: 'go', label: 'Go', plan: [{ fn: 'noop', params: {} }, LOOKUP('9999'), LOOKUP()] }] });
    const r = await cta.respond(db, { token: row.token, value: 'go' });
    expect(r).toEqual({ ok: true, status: 'failed', execution_id: expect.any(Number) });
    expect(W.link(row.id).status).toBe('used');
    const [e] = W.execs(row.id);
    const steps = JSON.parse(e.plan_result);
    expect(e.status).toBe('failed');
    expect(steps.map((s) => [s.fn, s.ok])).toEqual([['noop', true], ['lookup_contact', false]]);   // stopped at step 2
    expect(steps[1].error).toMatch(/Contact 9999 not found/);
    expect(contactsReads()).toBe(1);
    expect(ctaAlerts()).toEqual([expect.objectContaining({
      source: 'cta', kind: 'plan_failed', severity: 'error', group_key: `cta:${row.id}`,
      ref_table: 'cta_executions', ref_id: e.id,
    })]);
    expect(decodeLog(W.logs[0]).data.status).toBe('failed');
  });

  test('success:false (without a throw) also fails the plan', async () => {
    const name = 'cta_test_soft_fail';
    registry[name] = Object.assign(async () => ({ success: false, error: 'soft no' }), { __meta: { category: 'dev', description: 't', params: [] } });
    try {
      const row = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [{ fn: name, params: {} }, LOOKUP()] }] });
      const r = await cta.respond(db, { token: row.token, value: 'go' });
      expect(r.status).toBe('failed');
      expect(JSON.parse(W.execs(row.id)[0].plan_result)[0]).toMatchObject({ ok: false, error: 'soft no' });
      expect(contactsReads()).toBe(0);
    } finally {
      delete registry[name];
    }
  });

  test('return_plan_result=1 opts the raw plan_result into the JSON surface', async () => {
    const row = W.seedLink({ return_plan_result: 1, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    const r = await cta.respond(db, { token: row.token, value: 'go' });
    expect(r.plan_result).toEqual([expect.objectContaining({ fn: 'lookup_contact', ok: true })]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// respond — repeatable
// ═════════════════════════════════════════════════════════════════════════════

describe('respond — mode repeatable', () => {
  test('each click is one execution; status stays active', async () => {
    const m = await cta.mintCta(db, baseMint({ mode: 'repeatable' }));
    for (let i = 0; i < 3; i++) expect((await cta.respond(db, { token: m.token, value: 'spam' })).ok).toBe(true);
    expect(W.link(m.id)).toMatchObject({ status: 'active', uses_count: 3 });
    expect(W.execs(m.id)).toHaveLength(3);
  });

  test('MAX_USES RACE: three clicks for the last use — exactly one increments', async () => {
    const row = W.seedLink({ mode: 'repeatable', max_uses: 2, uses_count: 1, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    W.gate(/^UPDATE cta_links SET uses_count = uses_count \+ 1/, 3);
    const rs = await Promise.all([1, 2, 3].map(() => cta.respond(db, { token: row.token, value: 'go' })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'exhausted' }, { ok: false, code: 'exhausted' }]);
    expect(W.link(row.id).uses_count).toBe(2);
    expect(W.execs(row.id)).toHaveLength(1);
  });

  test('PASSWORD BEFORE INCREMENT: a wrong password never burns a use', async () => {
    const row = W.seedLink({ mode: 'repeatable', max_uses: 1, protection: 'password', password_hash: bcrypt.hashSync('correct horse battery', 4), options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    for (let i = 0; i < 3; i++) {
      expect(await cta.respond(db, { token: row.token, value: 'go', password: 'nope' })).toEqual({ ok: false, code: 'bad_password' });
    }
    expect(W.link(row.id)).toMatchObject({ uses_count: 0, failed_attempts: 3 });
    expect(W.queries.some((q) => /uses_count = uses_count \+ 1/.test(q.sql))).toBe(false);
    expect((await cta.respond(db, { token: row.token, value: 'go', password: 'correct horse battery' })).ok).toBe(true);
    expect(await cta.respond(db, { token: row.token, value: 'go', password: 'correct horse battery' })).toEqual({ ok: false, code: 'exhausted' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Runtime guard + run-time eligibility re-check (§4.3)
// ═════════════════════════════════════════════════════════════════════════════

describe('runtime guard', () => {
  function withTempFn(name, impl, body) {
    registry[name] = Object.assign(impl, { __meta: { category: 'dev', description: 'flagless timing stand-in', params: [] } });
    return Promise.resolve().then(body).finally(() => { delete registry[name]; });
  }

  test.each([
    ['delayed_until', async () => ({ success: true, delayed_until: new Date(Date.now() + HOUR).toISOString() })],
    ['next_step', async () => ({ success: true, next_step: 4 })],
    ['next_step', async () => ({ success: true, next_step: null })],
    ['nextStep', async () => ({ success: true, nextStep: 2 })],
  ])('a flagless function returning %s fails the plan', (key, impl) =>
    withTempFn('cta_test_flagless_timer', impl, async () => {
      expect(cta.isCtaEligible('cta_test_flagless_timer')).toBe(true);   // passes the mint filter…
      const row = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [{ fn: 'cta_test_flagless_timer', params: {} }, LOOKUP()] }] });
      const r = await cta.respond(db, { token: row.token, value: 'go' });
      expect(r.status).toBe('failed');                                     // …the guard stops it
      const step = JSON.parse(W.execs(row.id)[0].plan_result)[0];
      expect(step.error).toMatch(new RegExp(`runtime guard: .* returned ${key}`));
      expect(contactsReads()).toBe(0);
    }));

  test('a function denied after mint is re-checked at run time', async () => {
    const row = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [{ fn: 'wait_until_time', params: { time: '09:00' } }] }] });
    const r = await cta.respond(db, { token: row.token, value: 'go' });
    expect(r.status).toBe('failed');
    expect(JSON.parse(W.execs(row.id)[0].plan_result)[0].error).toMatch(/not CTA-eligible at run time/);
  });

  test('guardTrip reads only engine-coupled keys', () => {
    expect(cta.guardTrip({ success: true, output: { next_step: 3 } })).toBeNull();
    expect(cta.guardTrip({ success: true, set_vars: { x: 1 } })).toBeNull();
    expect(cta.guardTrip({ success: true, delayed_until: null })).toBeNull();
    expect(cta.guardTrip(undefined)).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Running-row lifecycle (B7)
// ═════════════════════════════════════════════════════════════════════════════

describe('running-row crash visibility', () => {
  test('mid-plan, the link is claimed and the execution row already exists as running', async () => {
    let release;
    let observed;
    const row = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }] });
    W.on(/FROM contacts WHERE contact_id = \?/, () => {
      observed = { link: { ...W.link(row.id) }, execs: W.execs(row.id).map((e) => ({ ...e })) };
      return new Promise((r) => { release = r; });   // the "instance died here" stall
    });
    const pending = cta.respond(db, { token: row.token, value: 'go' });
    for (let i = 0; i < 50 && !release; i++) await new Promise((r) => setImmediate(r));
    expect(observed.link).toMatchObject({ status: 'used', uses_count: 1 });
    expect(observed.execs).toEqual([expect.objectContaining({ status: 'running', plan_result: null })]);
    release();
    expect((await pending).status).toBe('success');
    expect(W.execs(row.id)[0].status).toBe('success');
  });

  test('the sweep warns once per execution stuck running > 15 min', async () => {
    const row = W.seedLink({ status: 'used', uses_count: 1 });
    const id = W.nextId.cta_executions++;
    W.tables.cta_executions.set(id, { id, cta_id: row.id, option_value: 'go', status: 'running', plan_result: null, responded_via: 'link', responder_user_id: null, responder_ip: null, executed_at: new Date(Date.now() - 16 * 60e3) });
    const fresh = W.nextId.cta_executions++;
    W.tables.cta_executions.set(fresh, { id: fresh, cta_id: row.id, option_value: 'go', status: 'running', plan_result: null, responded_via: 'link', responder_user_id: null, responder_ip: null, executed_at: new Date(Date.now() - 5 * 60e3) });

    const s = await cta.sweepExpired(db);
    expect(s.stale_running).toBe(1);
    expect(ctaAlerts()).toEqual([expect.objectContaining({
      kind: 'execution_stale', severity: 'warning', group_key: `cta:${row.id}`,
      ref_id: id, dedup_key: `cta_exec_stale:${id}`,
    })]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Timeout sweep (§6, B3)
// ═════════════════════════════════════════════════════════════════════════════

describe('cta_expiry_sweep — timeout claim', () => {
  const timeoutRow = (over = {}) => W.seedLink({
    expires_at: new Date(Date.now() - 1000),
    timeout_option: 'default',
    attributed_user_id: NON_SU,
    options: [{ value: 'act', label: 'Act', plan: [LOOKUP()] }, { value: 'default', label: 'Default', plan: [LOOKUP()] }],
    ...over,
  });

  test('CLAIM BEFORE PLAN: the link is used before step 1 runs; via timeout; log by=0 (never attributed)', async () => {
    const row = timeoutRow();
    const statusAtPlanSteps = [];
    W.on(/FROM contacts WHERE contact_id = \?/, () => { statusAtPlanSteps.push(W.link(row.id).status); });
    const s = await cta.sweepExpired(db);
    expect(s).toMatchObject({ due: 1, claimed: 1, success: 1 });
    expect(statusAtPlanSteps).toEqual(['used']);   // every plan step ran after the claim, exactly once
    const [e] = W.execs(row.id);
    expect(e).toMatchObject({ option_value: 'default', responded_via: 'timeout', status: 'success', responder_user_id: null });
    expect(decodeLog(W.logs[0]).by).toBe(0);
    // the registry adapter is the same path
    expect((await registry.cta_expiry_sweep({}, db)).output).toMatchObject({ due: 0, claimed: 0 });
  });

  test('DOUBLE RUN: two overlapping sweeps — one claim, one plan', async () => {
    const row = timeoutRow();
    W.gate(/^UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW\(\) WHERE id=\? AND status='active' AND mode='once'/, 2);
    const [a, b] = await Promise.all([cta.sweepExpired(db), cta.sweepExpired(db)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.lost + b.lost).toBe(1);
    expect(W.execs(row.id)).toHaveLength(1);
    expect(contactsReads()).toBe(1);
  });

  test('respond and timeout are mutually exclusive on the clock', async () => {
    const live = timeoutRow({ expires_at: new Date(Date.now() + HOUR) });
    expect((await cta.sweepExpired(db)).due).toBe(0);                       // not due yet
    expect(W.link(live.id).status).toBe('active');
    W.link(live.id).expires_at = new Date(Date.now() - 1000);
    expect(await cta.respond(db, { token: live.token, value: 'act' })).toEqual({ ok: false, code: 'expired' });
    expect((await cta.sweepExpired(db)).claimed).toBe(1);                   // the timeout wins
    expect(W.execs(live.id).map((e) => e.option_value)).toEqual(['default']);
  });

  test('a stale pre-check cannot let a click claim an expired link (the SQL clock decides)', async () => {
    const row = timeoutRow({ expires_at: new Date(Date.now() + HOUR) });
    const read = await cta.getCtaByToken(db, row.token);                  // looks active
    W.link(row.id).expires_at = new Date(Date.now() - 1000);               // expires before the UPDATE
    expect(await cta.respond(db, { row: read, value: 'act' })).toEqual({ ok: false, code: 'expired' });
    expect(W.execs(row.id)).toHaveLength(0);
  });

  test.each([
    ['a PATCH extends the expiry', (r) => { r.expires_at = new Date(Date.now() + HOUR); }],
    ['a click claims it', (r) => { Object.assign(r, { status: 'used', uses_count: 1 }); }],
    ['a PATCH disables it', (r) => { r.status = 'disabled'; }],
    ['uses_count is non-zero on an active row', (r) => { r.uses_count = 1; }],
  ])('the timeout claim loses when, between the due read and the claim, %s', async (_, mutate) => {
    const row = timeoutRow();
    W.on(/^UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW\(\) WHERE id=\? AND status='active' AND mode='once'/, () => mutate(W.link(row.id)));
    expect(await cta.sweepExpired(db)).toMatchObject({ due: 1, claimed: 0, lost: 1 });
    expect(W.execs(row.id)).toHaveLength(0);
    expect(contactsReads()).toBe(0);
  });

  test('without timeout_option an expired link just stays expired', async () => {
    const row = timeoutRow({ timeout_option: null });
    expect((await cta.sweepExpired(db)).due).toBe(0);
    expect(W.link(row.id).status).toBe('active');
  });

  test('kill switch: an su mint whose minter lost SU is claimed but its plan never runs', async () => {
    const row = timeoutRow({ minted_by: NON_SU });
    const s = await cta.sweepExpired(db);
    expect(s).toMatchObject({ claimed: 1, blocked: 1, success: 0 });
    expect(W.link(row.id).status).toBe('used');
    expect(W.execs(row.id)[0]).toMatchObject({ status: 'failed', responded_via: 'timeout' });
    expect(contactsReads()).toBe(0);
    expect(ctaAlerts()).toEqual([expect.objectContaining({ kind: 'timeout_blocked', severity: 'warning' })]);
    expect(decodeLog(W.logs[0])).toMatchObject({ by: 0 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PATCH (§5.3)
// ═════════════════════════════════════════════════════════════════════════════

describe('patchCta', () => {
  const failedOnce = async (over = {}) => {
    const row = W.seedLink({ options: [{ value: 'go', label: 'Go', plan: [LOOKUP('9999')] }], ...over });
    await cta.respond(db, { token: row.token, value: 'go' });
    expect(W.link(row.id).status).toBe('used');
    return row;
  };

  test('RE-ENABLE after a failed run resets uses_count and re-runs the whole plan on the next click', async () => {
    const row = await failedOnce();
    expect(W.link(row.id).uses_count).toBe(1);
    const p = await cta.patchCta(db, row.id, { status: 'active' });
    expect(p.changed).toBe(true);
    expect(p.after).toMatchObject({ status: 'active', uses_count: 0 });
    W.contacts.set(9999, { contact_id: 9999 });
    expect(await cta.respond(db, { token: row.token, value: 'go' })).toMatchObject({ ok: true, status: 'success' });
    expect(W.execs(row.id).map((e) => e.status)).toEqual(['failed', 'success']);
  });

  test('re-enable revives the timeout claim (it requires uses_count=0)', async () => {
    const row = await failedOnce({ timeout_option: 'go' });
    await cta.patchCta(db, row.id, { status: 'active', expires_at: new Date(Date.now() + HOUR).toISOString() });
    W.link(row.id).expires_at = new Date(Date.now() - 1000);
    W.contacts.set(9999, { contact_id: 9999 });
    expect(await cta.sweepExpired(db)).toMatchObject({ claimed: 1, success: 1 });
  });

  test('re-enable needs the latest execution to have failed', async () => {
    const m = await cta.mintCta(db, baseMint());
    await cta.respond(db, { token: m.token, value: 'spam' });
    await expectStatus(cta.patchCta(db, m.id, { status: 'active' }), 409, /latest execution to have failed.*\(it is success\)/);
  });

  // ── S2 ruling: a run stuck 'running' > 15 min is a dead instance ─────────
  const seedExec = (ctaId, over = {}) => {
    const id = W.nextId.cta_executions++;
    const e = {
      id, cta_id: ctaId, option_value: 'go', status: 'running', plan_result: null,
      responded_via: 'link', responder_user_id: null, responder_ip: null,
      executed_at: new Date(), ...over,
    };
    W.tables.cta_executions.set(id, e);
    return e;
  };
  const usedLink = (over = {}) => W.seedLink({
    status: 'used', uses_count: 1, options: [{ value: 'go', label: 'Go', plan: [LOOKUP()] }], ...over,
  });

  test('STALE RUNNING: re-enable finalizes a >15-min running row as failed FIRST, then re-enables', async () => {
    const row = usedLink();
    const ex = seedExec(row.id, { executed_at: new Date(Date.now() - 16 * 60e3) });
    const order = [];
    W.on(/^UPDATE cta_executions SET status = 'failed'/, () => order.push('finalize'));
    W.on(/^UPDATE cta_links SET uses_count = 0/, () => order.push('reenable'));
    const p = await cta.patchCta(db, row.id, { status: 'active' });
    expect(order).toEqual(['finalize', 'reenable']);
    expect(p.finalized_execution_id).toBe(ex.id);
    expect(p.after).toMatchObject({ status: 'active', uses_count: 0 });
    expect(ex.status).toBe('failed');
    expect(JSON.parse(ex.plan_result)[0].error).toMatch(/finalized as failed by an SU re-enable/);
    // and the next click re-runs the plan
    expect(await cta.respond(db, { token: row.token, value: 'go' })).toMatchObject({ ok: true, status: 'success' });
  });

  test('STALE RUNNING: the threshold is strictly over 15 min (injected clock), and under it is 409 with nothing written', async () => {
    const row = usedLink();
    const at = new Date(Date.now() - 60e3);
    const ex = seedExec(row.id, { executed_at: at });
    const exactly15 = new Date(at.getTime() + 15 * 60e3);
    await expectStatus(cta.patchCta(db, row.id, { status: 'active' }, { now: exactly15 }), 409,
      /stuck running over 15 min \(it is running\)/);
    expect(ex.status).toBe('running');
    expect(W.link(row.id)).toMatchObject({ status: 'used', uses_count: 1 });
    expect(W.queries.some((q) => /^UPDATE /.test(q.sql))).toBe(false);
    const p = await cta.patchCta(db, row.id, { status: 'active' }, { now: new Date(exactly15.getTime() + 1) });
    expect(p.finalized_execution_id).toBe(ex.id);
    expect(ex.status).toBe('failed');
  });

  test('STALE RUNNING: an expired link without an extension is 400 BEFORE the row is finalized', async () => {
    const row = usedLink({ expires_at: new Date(Date.now() - 1000) });
    const ex = seedExec(row.id, { executed_at: new Date(Date.now() - 20 * 60e3) });
    await expect400(cta.patchCta(db, row.id, { status: 'active' }), /extend expires_at in the same PATCH/);
    expect(ex.status).toBe('running');
    expect(W.queries.some((q) => /^UPDATE /.test(q.sql))).toBe(false);
  });

  test('STALE RUNNING: a plan that finishes between the read and the finalize wins — judged on its real outcome', async () => {
    // success lands first → nothing to re-enable
    const a = usedLink();
    const exA = seedExec(a.id, { executed_at: new Date(Date.now() - 16 * 60e3) });
    W.on(/^UPDATE cta_executions SET status = 'failed'/, (sql, params) => {
      const e = W.tables.cta_executions.get(Number(params[1]));
      if (e.cta_id === a.id) e.status = 'success';   // executeOpened's own finalize landed first
      else e.status = 'failed';
    });
    await expectStatus(cta.patchCta(db, a.id, { status: 'active' }), 409, /finished while this PATCH was applied \(now success\)/);
    expect(exA.status).toBe('success');
    expect(W.link(a.id)).toMatchObject({ status: 'used', uses_count: 1 });

    // failure lands first → re-enable proceeds, but it was not OUR finalize
    const b = usedLink();
    const exB = seedExec(b.id, { executed_at: new Date(Date.now() - 16 * 60e3) });
    const p = await cta.patchCta(db, b.id, { status: 'active' });
    expect(exB.status).toBe('failed');
    expect(exB.plan_result).toBeNull();               // its own (simulated) finalize, not our marker
    expect(p.finalized_execution_id).toBeUndefined();
    expect(p.after).toMatchObject({ status: 'active', uses_count: 0 });
  });

  test('adminRow never carries password_hash; state is derived', async () => {
    const m = await cta.mintCta(db, baseMint({ protection: 'password' }));
    const row = await cta.getCtaById(db, m.id);
    expect(row.password_hash).toMatch(/^\$2[aby]\$12\$/);
    const a = cta.adminRow(row);
    expect(a).not.toHaveProperty('password_hash');
    expect(a).toMatchObject({ id: m.id, state: 'active', token: m.token });
  });

  test('re-enabling an expired link needs an extension in the same PATCH', async () => {
    const row = await failedOnce();
    W.link(row.id).expires_at = new Date(Date.now() - 1000);
    await expect400(cta.patchCta(db, row.id, { status: 'active' }), /extend expires_at in the same PATCH/);
    const p = await cta.patchCta(db, row.id, { status: 'active', expires_at: new Date(Date.now() + DAY).toISOString() });
    expect(p.after.status).toBe('active');

    const dis = W.seedLink({ status: 'disabled', expires_at: new Date(Date.now() - 1000) });
    await expect400(cta.patchCta(db, dis.id, { status: 'active' }), /extend expires_at/);
  });

  test('a claimed single-use link: anything but re-enable/cancel is 409', async () => {
    const m = await cta.mintCta(db, baseMint());
    await cta.respond(db, { token: m.token, value: 'spam' });
    await expectStatus(cta.patchCta(db, m.id, { status: 'disabled' }), 409, /already claimed/);
    await expectStatus(cta.patchCta(db, m.id, { expires_at: new Date(Date.now() + DAY).toISOString() }), 409, /already claimed/);
    expect((await cta.patchCta(db, m.id, { status: 'cancelled' })).after.status).toBe('cancelled');
  });

  test('cancelled is permanent (R8)', async () => {
    const row = W.seedLink({ status: 'cancelled' });
    await expectStatus(cta.patchCta(db, row.id, { status: 'active' }), 409, /permanent/);
    await expectStatus(cta.patchCta(db, row.id, { expires_at: new Date(Date.now() + DAY).toISOString() }), 409, /permanent/);
    expect(W.link(row.id).status).toBe('cancelled');
  });

  test('disabled ↔ active; extend; bounds; unknown fields', async () => {
    const row = W.seedLink();
    expect((await cta.patchCta(db, row.id, { status: 'disabled' })).after.status).toBe('disabled');
    expect((await cta.respond(db, { token: row.token, value: 'x' })).code).toBe('disabled');
    expect((await cta.patchCta(db, row.id, { status: 'active' })).after.status).toBe('active');
    const later = new Date(Date.now() + 10 * DAY);
    expect((await cta.patchCta(db, row.id, { expires_at: later.toISOString() })).after.expires_at.getTime()).toBe(later.getTime());
    await expect400(cta.patchCta(db, row.id, { expires_at: new Date(Date.now() + 366 * DAY).toISOString() }), /365d/);
    await expect400(cta.patchCta(db, row.id, { status: 'used' }), /status must be/);
    await expect400(cta.patchCta(db, row.id, { uses_count: 0 }), /unknown field "uses_count"/);
    await expect400(cta.patchCta(db, row.id, {}), /nothing to change/);
    await expectStatus(cta.patchCta(db, 999, { status: 'disabled' }), 404);
  });

  test('max_uses: repeatable only, not below uses_count, null clears', async () => {
    const once = W.seedLink();
    await expect400(cta.patchCta(db, once.id, { max_uses: 5 }), /repeatable only/);
    const rep = W.seedLink({ mode: 'repeatable', max_uses: 2, uses_count: 2 });
    await expect400(cta.patchCta(db, rep.id, { max_uses: 1 }), /below uses_count/);
    expect((await cta.patchCta(db, rep.id, { max_uses: 5 })).after.max_uses).toBe(5);
    expect((await cta.patchCta(db, rep.id, { max_uses: null })).after.max_uses).toBeNull();
  });

  test('STATUS-GUARDED: a click that claims between the PATCH read and write → 409, no overwrite', async () => {
    const row = W.seedLink();
    W.on(/^UPDATE cta_links SET status = \?, updated_at = NOW\(\) WHERE id = \? AND status = \?$/, () => {
      Object.assign(W.link(row.id), { status: 'used', uses_count: 1 });   // the concurrent claim lands
    });
    await expectStatus(cta.patchCta(db, row.id, { status: 'disabled' }), 409, /changed while this PATCH/);
    expect(W.link(row.id).status).toBe('used');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Surface helpers + SQL text
// ═════════════════════════════════════════════════════════════════════════════

describe('publicDescriptor (§5.2)', () => {
  test('carries prompt/options/state and never name, plans or templates', async () => {
    const m = await cta.mintCta(db, baseMint({
      mode: 'repeatable', max_uses: 4,
      options: [{ value: 'get', label: 'Get', plan: [LOOKUP()], result_template: 'x [[1.output]]', confirm_text: 'Sure?' }],
      protection: 'none',
    }));
    const d = cta.publicDescriptor(await cta.getCtaById(db, m.id));
    expect(d).toEqual({
      prompt: 'Is this lead spam?', options: [{ value: 'get', label: 'Get' }], mode: 'repeatable',
      protection: 'none', expires_at: m.expires_at, uses_remaining: 4, status: 'active',
    });
    expect(JSON.stringify(d)).not.toMatch(/Mark lead as spam|lookup_contact|output|Sure\?/);
  });
});

describe('§6 SQL is verbatim', () => {
  const n = (s) => s.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  test('claim / increment / timeout-claim', () => {
    expect(n(cta.CLAIM_ONCE_SQL)).toBe(n(`UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW();`));
    expect(n(cta.INCREMENT_SQL)).toBe(n(`UPDATE cta_links SET uses_count = uses_count + 1, updated_at=NOW()
 WHERE id=? AND status='active' AND expires_at > NOW()
   AND (max_uses IS NULL OR uses_count < max_uses);`));
    expect(n(cta.TIMEOUT_CLAIM_SQL)).toBe(n(`UPDATE cta_links SET status='used', uses_count=1, updated_at=NOW()
 WHERE id=? AND status='active' AND mode='once' AND uses_count=0
   AND timeout_option IS NOT NULL AND expires_at <= NOW();`));
  });
});
