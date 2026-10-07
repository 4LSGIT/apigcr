// tests/ctaCreateFn.test.js
//
/**
 * create_cta (CTA arc S3) — lib/internal_functions/cta.js, ref/CTA_DESIGN.md §10 S3.
 *
 * WHAT IS LOCKED
 *   - Engine-injected _params are stripped (the service's MINT_KEYS check
 *     would 400 on them) and _execution_id becomes source_execution_id.
 *   - The row mints as mint_source='workflow' / minted_by 0 — the B1 shape
 *     that exempts clicks from the active-SU check.
 *   - dry_run, mint_source/minted_by/source_execution_id in step config,
 *     password protection, and result_template-without-explicit-'none' all
 *     throw BEFORE any insert.
 *   - Output carries the link bundle (cta_url, per-option urls,
 *     options_html, email_html) built from the REAL token.
 *
 * HARNESS: the REAL registry function and REAL ctaService against
 * tests/helpers/ctaWorld.js. firmConfig is mocked (lib/ctaLinks reads
 * publicUrl() at compose time; the fixed origin makes URLs assertable).
 *
 * Run: npx jest tests/ctaCreateFn.test.js
 */
'use strict';

jest.mock('../lib/alerting', () => ({ alert: jest.fn(async () => {}) }));
jest.mock('../lib/firmConfig', () => ({ publicUrl: jest.fn(() => 'https://4lsg.com') }));

const registry = require('../lib/internal_functions');
const cta = require('../services/ctaService');
const { makeCtaWorld } = require('./helpers/ctaWorld');

const EXEC = 777;
const TOKEN_RE = /^[0-9A-Za-z]{22}$/;

/** Step config exactly as the engine hands it over: resolved config + the
 *  three injected underscore params (workflow_engine.executeStep). */
function engineParams(extra = {}) {
  return {
    name: 'WF27 not-spam reentry',
    prompt: 'This website hit was flagged as spam. Not spam after all?',
    options: [
      { value: 'not_spam', label: 'Not spam — re-run intake', plan: [{ fn: 'noop', params: {} }] },
      { value: 'confirm_spam', label: 'Yes, spam', plan: [{ fn: 'noop', params: {} }] },
    ],
    timeout: '30d',
    _variables: { lead_name: 'Brian Bartlett', ai_spam: 'yes' },
    _step_number: 40,
    _execution_id: EXEC,
    ...extra,
  };
}

let db;
let W;

beforeEach(() => {
  db = makeCtaWorld();
  W = db.W;
});

describe('create_cta — happy path', () => {
  test('mints mint_source=workflow / minted_by 0 / source_execution_id from _execution_id', async () => {
    const r = await registry.create_cta(engineParams(), db);
    expect(r.success).toBe(true);
    expect(r.output.token).toMatch(TOKEN_RE);

    const row = W.link(r.output.cta_id);
    expect(row.status).toBe('active');
    expect(row.mint_source).toBe('workflow');
    expect(row.minted_by).toBe(0);
    expect(row.source_execution_id).toBe(EXEC);
    expect(row.protection).toBe('none');
  });

  test('output carries the link bundle built from the real token', async () => {
    const r = await registry.create_cta(engineParams(), db);
    const t = r.output.token;
    expect(r.output.cta_url).toBe(`https://4lsg.com/c/${t}`);
    expect(r.output.urls).toEqual({
      not_spam: `https://4lsg.com/c/${t}/not_spam`,
      confirm_spam: `https://4lsg.com/c/${t}/confirm_spam`,
    });
    expect(r.output.options_html).toContain(`/c/${t}/not_spam`);
    expect(r.output.email_html).toContain(`/c/${t}`);
    expect(r.output.email_html).toContain('Not spam — re-run intake');
    expect(r.output.mode).toBe('once');
    expect(typeof r.output.expires_at).toBe('string');
  });

  test('the underscore strip is load-bearing: the service itself rejects engine params', async () => {
    // Negative control for the strip — if create_cta ever forwards the
    // injected keys, this is the 400 every workflow mint would hit.
    await expect(cta.mintCta(db, { ...engineParams(), mint_source: 'workflow', minted_by: 0, source_execution_id: EXEC }))
      .rejects.toThrow(/unknown field "_variables"/);
  });
});

describe('create_cta — refusals (no insert)', () => {
  afterEach(() => {
    expect(W.tables.cta_links.size).toBe(0); // every refusal here must happen before any insert
  });

  test('outside a workflow execution', async () => {
    const p = engineParams();
    delete p._execution_id;
    await expect(registry.create_cta(p, db)).rejects.toThrow(/inside a workflow execution/);
  });

  test.each([[true], [false], ['true'], ['false'], ['']])('dry_run present (%p)', async (v) => {
    await expect(registry.create_cta(engineParams({ dry_run: v }), db)).rejects.toThrow(/remove dry_run/);
  });

  test.each([['mint_source', 'workflow'], ['minted_by', 0], ['source_execution_id', 12]])(
    'engine-owned key %s in step config', async (k, v) => {
      await expect(registry.create_cta(engineParams({ [k]: v }), db)).rejects.toThrow(/set by the engine/);
    });

  test('password protection refused (secret would land in step output_data)', async () => {
    await expect(registry.create_cta(engineParams({ protection: 'password' }), db)).rejects.toThrow(/cannot be minted from workflows/);
    await expect(registry.create_cta(engineParams({ password: 'supersecret12' }), db)).rejects.toThrow(/cannot be minted from workflows/);
  });

  test("result_template without explicit protection:'none'", async () => {
    const p = engineParams();
    p.options[0].result_template = 'Done: [[1.output.message]]';
    await expect(registry.create_cta(p, db)).rejects.toThrow(/protection:'none' explicitly/);
  });
});

describe('create_cta — result_template with explicit none', () => {
  test('mints unprotected when the author opts in', async () => {
    const p = engineParams({ protection: 'none' });
    p.options[0].result_template = 'Done: [[1.output.message]]';
    const r = await registry.create_cta(p, db);
    expect(r.success).toBe(true);
    expect(W.link(r.output.cta_id).protection).toBe('none');
  });
});

describe('registry exposure', () => {
  test('create_cta is registered, workflowOnly, and CTA-denylisted', () => {
    expect(typeof registry.create_cta).toBe('function');
    expect(registry.create_cta.__meta.workflowOnly).toBe(true);
    expect(cta.CTA_FN_DENYLIST).toContain('create_cta');       // a link must not mint links
    expect(cta.eligibleFunctionNames()).not.toContain('create_cta');
  });
});
