// lib/internal_functions/cta.js
//
// CTA (Call To Action) internal functions — ref/CTA_DESIGN.md.
//
//   cta_expiry_sweep  — S1. Recurring (~5 min) job seeded by
//                       ref/migrations/2026-10-07_cta.sql. Internal plumbing.
//   create_cta        — S3. Workflow mint: a thin registry adapter over
//                       ctaService.mintCta(mint_source='workflow').
//
// All logic lives in services/ctaService.js; this file is the registry
// adapter only.

const fns = {};

/**
 * cta_expiry_sweep
 * Claim-first timeout runs for expired single-use CTA links with a
 * timeout_option, then warn on CTA executions stuck 'running' > 15 min.
 * Overlapping runs are benign: the timeout claim is a guarded UPDATE and
 * the plan only runs on affectedRows=1.
 */
fns.cta_expiry_sweep = async (params, db) => {
  const ctaService = require('../../services/ctaService'); // lazy require (circular dep safety)
  const summary = await ctaService.sweepExpired(db, { limit: params && params.limit });
  if (summary.claimed || summary.stale_running || summary.errors) {
    console.log(
      `[CTA SWEEP] due=${summary.due} claimed=${summary.claimed} success=${summary.success} ` +
      `failed=${summary.failed} blocked=${summary.blocked} lost=${summary.lost} ` +
      `errors=${summary.errors} stale_running=${summary.stale_running}`
    );
  }
  return { success: true, output: summary };
};

fns.cta_expiry_sweep.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "CTA Expiry Sweep" recurring job
  description:
    'Internal: runs the timeout_option plan of expired single-use CTA links (claiming each first, ' +
    'so overlapping runs never double-fire) and warns on CTA executions stuck running > 15 min. ' +
    'Driven by the "CTA Expiry Sweep" recurring job — do not add to workflows.',
  params: [
    { name: 'limit', type: 'integer', required: false, min: 1, max: 500, default: 50,
      description: 'Max due CTA links processed per run (default 50).' },
  ],
  example: {},
};

// ─────────────────────────────────────────────────────────────
// create_cta — S3 (workflow mint)
// ─────────────────────────────────────────────────────────────

/**
 * Mint a CTA link from inside a workflow (ref/CTA_DESIGN.md §10 S3).
 *
 * The engine's {{...}} pass has already resolved every placeholder in the
 * step config by the time this runs, so dynamic content (envelope keys,
 * contact ids) freezes into the row for free; the service then REJECTS any
 * leftover unresolved {{...}} — an author typo must not mint a link whose
 * plan re-runs with '' for its input.
 *
 * Engine-injected params (_variables, _step_number, _execution_id — see
 * workflow_engine.executeStep) are stripped before the mint: the service's
 * MINT_KEYS check would 400 on them. _execution_id becomes
 * source_execution_id (B1 audit linkage) and the mint runs as
 * mint_source='workflow', which is also what EXEMPTS the link from the
 * active-SU click check (user 0 is not SU — B1).
 *
 * v1 limits (ref/CTA_DESIGN.md §10 S3):
 *   - protection='password' refused: the auto-secret would land in
 *     workflow_execution_steps.output_data, readable via any RO key.
 *   - result_template therefore requires an EXPLICIT protection:'none'
 *     (the service would otherwise default it to 'password').
 *   - dry_run refused outright: workflow params resolve to strings, and the
 *     service treats anything but boolean true as a REAL mint — any dry_run
 *     here is a config bug that must fail loudly, not insert a row.
 */
fns.create_cta = async (params, db) => {
  const ctaService = require('../../services/ctaService'); // lazy require (circular dep safety)
  const ctaLinks   = require('../ctaLinks');

  const p = { ...(params || {}) };
  const executionId = Number(p._execution_id);
  for (const k of Object.keys(p)) if (k.startsWith('_')) delete p[k];

  if (!Number.isInteger(executionId) || executionId <= 0) {
    throw new Error('create_cta can only run inside a workflow execution');
  }
  if ('dry_run' in p) {
    throw new Error('create_cta: remove dry_run — workflow mints are always real (resolved params are strings, which the service would treat as a live mint)');
  }
  if ('mint_source' in p || 'minted_by' in p || 'source_execution_id' in p) {
    throw new Error('create_cta: mint_source / minted_by / source_execution_id are set by the engine, not by step config');
  }
  if (p.protection === 'password' || 'password' in p) {
    throw new Error('create_cta: password-protected CTAs cannot be minted from workflows — the secret would be stored in step output_data (RO-readable). Mint via POST /api/cta instead');
  }
  const hasResultTemplate = Array.isArray(p.options) &&
    p.options.some((o) => o && typeof o === 'object' && o.result_template != null && o.result_template !== '');
  if (hasResultTemplate && p.protection !== 'none') {
    throw new Error("create_cta: result_template defaults protection to 'password', which workflows cannot mint. Set protection:'none' explicitly to accept an unprotected result link, or mint via POST /api/cta");
  }

  const receipt = await ctaService.mintCta(db, {
    ...p,
    mint_source: 'workflow',
    minted_by: 0,
    source_execution_id: executionId,
  });

  const bundle = ctaLinks.linkBundle({
    token: receipt.token,
    options: receipt.options,
    expiresAt: receipt.expires_at,
    prompt: typeof p.prompt === 'string' ? p.prompt.trim() : '',
    protection: receipt.protection,
    timeoutOption: receipt.timeout_option,
  });

  console.log(
    `[CREATE_CTA] minted #${receipt.id} "${receipt.name}" exec=${executionId} ` +
    `mode=${receipt.mode} options=[${receipt.options.map((o) => o.value).join(',')}] expires=${receipt.expires_at}`
  );

  return {
    success: true,
    output: {
      cta_id: receipt.id,
      token: receipt.token,
      cta_url: bundle.cta_url,
      urls: bundle.urls,
      options_html: bundle.options_html,
      email_html: bundle.email_html,
      expires_at: receipt.expires_at,
      name: receipt.name,
      mode: receipt.mode,
      protection: receipt.protection,
      notes: receipt.notes,
      warnings: receipt.warnings,
    },
  };
};

fns.create_cta.__meta = {
  category: 'composition',
  // Workflows only: source_execution_id (B1 audit linkage) comes from the
  // engine-injected _execution_id, which sequences don't have.
  workflowOnly: true,
  description:
    'Mint a CTA link (ref/CTA_DESIGN.md) whose option buttons run pre-authorized plans when clicked. ' +
    'Runs as mint_source=workflow (no SU click check; audit-linked to this execution). Output: cta_id, token, ' +
    'cta_url, urls (per-option confirm pages), options_html, email_html, expires_at — capture with set_vars and ' +
    'feed a send_email step. Password protection and dry_run are refused here; mint those via POST /api/cta.',
  params: [
    { name: 'name', type: 'string', required: true, placeholderAllowed: true,
      description: 'Internal label shown in the SU list (never public). Max 120 chars.',
      example: 'WF27 not-spam reentry — {{lead_name}}' },
    { name: 'prompt', type: 'string', required: true, placeholderAllowed: true, multiline: true,
      description: 'Escaped text shown to the recipient on the /c/ pages and in the default email. Max 2000 chars.',
      example: 'This website hit was flagged as spam. Not spam after all?' },
    { name: 'options', type: 'array', required: true,
      description: "JSON array of 1-10 {value,label,plan,confirm_text?,result_template?}. Each plan is 1-20 {fn,params} steps of eligible registry functions; params are frozen literals ({{...}} resolves before the mint). result_template requires explicit protection:'none' here.",
      example: [{ value: 'not_spam', label: 'Not spam — re-run intake', plan: [{ fn: 'start_workflow', params: { workflow_id: '27', init_data: {} } }] }] },
    { name: 'context_html', type: 'string', required: false, placeholderAllowed: true, multiline: true,
      description: 'TRUSTED HTML block shown under the prompt (same contract as request_decision context_html). Max 200k chars.' },
    { name: 'mode', type: 'enum', required: false, enum: ['once', 'repeatable'],
      description: "Default 'once' (atomic single-use claim). 'repeatable' allows every click until expiry/max_uses." },
    { name: 'max_uses', type: 'integer', required: false,
      description: 'repeatable only: cap on total executions. Omit for "until expiry".' },
    { name: 'timeout', type: 'duration', required: false, placeholderAllowed: true,
      description: 'Lifetime — "2h", "3d", "30m", or ms. Default: cta_default_timeout_once / _repeatable setting. Max 365d. Mutually exclusive with expires_at.' },
    { name: 'expires_at', type: 'string', required: false, placeholderAllowed: true,
      description: 'Absolute expiry instead of timeout (naive datetimes are firm-local).' },
    { name: 'timeout_option', type: 'string', required: false,
      description: 'once only: option value whose plan auto-runs at expiry if nobody clicked (the sweep claims first).' },
    { name: 'return_plan_result', type: 'boolean', required: false, default: false,
      description: 'JSON respond surface may include raw plan_result (agent mints). HTML pages never show it.' },
    { name: 'attributed_user_id', type: 'integer', required: false, placeholderAllowed: true,
      description: 'Attribute link/password responses to this user in outcome logs (assertion by mint, not authentication).' },
    { name: 'link_type', type: 'string', required: false,
      description: 'Outcome-log linkage: logService ABOUT_TYPES value (contact, case, ...). Requires link_id.' },
    { name: 'link_id', type: 'string', required: false, placeholderAllowed: true,
      description: 'Id for link_type.', example: '{{lead_case_id}}' },
  ],
  example: {
    name: 'WF27 not-spam reentry',
    prompt: 'This website hit was flagged as spam and no lead was created. Not spam after all?',
    options: [{ value: 'not_spam', label: 'Not spam — re-run intake',
                plan: [{ fn: 'start_workflow', params: { workflow_id: '27', init_data: { spam_override: 1 } } }] }],
    timeout: '30d',
    link_type: 'contact',
  },
};

module.exports = fns;
