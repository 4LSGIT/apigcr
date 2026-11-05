// lib/internal_functions/mail.js
//
// Provider email events (YisraMail T2 — ref/YISRAMAIL_DESIGN.md §5.4).
//
// CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST) — engine plumbing: it
// writes the consent ledger (opt-outs) and campaign delivery state from a
// provider payload; only the `ses-events` hook may run it. It runs no code
// body, so it has no guest-code lane.

const fns = {};

/**
 * mail_event_ingest
 * One provider event (the hook body — an EventBridge event wrapping an SES
 * event) → campaign_results delivery columns, consent ledger opt-outs for hard
 * bounces and complaints, a follow-up task for a client's bounce, alerts —
 * and, since C6, engagement: Open/Click set opened_at/clicked_at and write
 * campaign_clicks (never the delivery columns or the ledger).
 * services/mailEventService.ingest holds the rules.
 */
fns.mail_event_ingest = async (params = {}, db) => {
  const svc = require('../../services/mailEventService'); // lazy require (convention)
  const output = await svc.ingest(db, params.event, { driver: params.driver || 'ses' });
  return { success: true, output };
};

fns.mail_event_ingest.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — the ses-events hook's target only
  description:
    'Internal: ingest one provider email event (hook ses-events, params mapping event ← body). Updates the ' +
    'campaign_results delivery columns (by the result_id message tag, else the provider message id), records ' +
    'hard bounces and complaints as marketing opt-outs in the consent ledger (idempotent on the provider event ' +
    'id), opens one follow-up task for a client whose address hard-bounced, and raises complaint / bounce-rate ' +
    'alerts. Open/Click events (C6) stamp opened_at/clicked_at and campaign_clicks instead — engagement only. ' +
    'Not for workflows; not CTA-eligible. ref/YISRAMAIL_DESIGN.md §5.4.',
  params: [
    { name: 'event', type: 'object', required: true, description: 'The provider event as the hook received it (body).' },
    { name: 'driver', type: 'string', required: false, description: 'Events driver; default ses.' },
  ],
  example: {},
};

module.exports = fns;
