// lib/internal_functions/cta.js
//
// CTA (Call To Action) internal functions — ref/CTA_DESIGN.md.
//
//   cta_expiry_sweep  — S1. Recurring (~5 min) job seeded by
//                       ref/migrations/2026-10-07_cta.sql. Internal plumbing.
//   create_cta        — S3 (workflow mint). Not here yet.
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

module.exports = fns;
