// lib/internal_functions/consent.js
//
// SMS consent plumbing (YisraMail P2 — ref/YISRAMAIL_DESIGN.md §4.6).
//
// CTA: DENIED (services/ctaService.js CTA_FN_DENYLIST) — engine plumbing that
// spends a provider rate group and writes the consent ledger; no public link
// may start it.

const fns = {};

/**
 * sms_consent_sync
 * One run of the read-only RingCentral consent reconcile
 * (phoneConsentService.syncRcConsents — fail-closed on
 * sms_rc_consent_sync_enabled) followed by the per-provider inbound liveness
 * check (inboundLivenessCheck). Driven by the nightly "SMS consent sync"
 * recurring job. Both halves run even when the other throws; the run then
 * fails, so the failed-job sweep reports it. Safe to run twice at once: the
 * reconcile holds GET_LOCK('sms_consent_sync:<db>') and the liveness alerts
 * carry a per-day dedup key.
 */
fns.sms_consent_sync = async (params = {}, db) => {
  const svc = require('../../services/phoneConsentService'); // lazy require (convention)
  const dryRun = params.dry_run === true || params.dry_run === 'true';
  const output = { reconcile: null, liveness: null };
  const failures = [];
  try {
    output.reconcile = await svc.syncRcConsents(db, { dryRun });
  } catch (err) {
    failures.push(`reconcile: ${err.message}`);
  }
  try {
    output.liveness = await svc.inboundLivenessCheck(db);
  } catch (err) {
    failures.push(`liveness: ${err.message}`);
  }
  const r = output.reconcile || {};
  console.log(
    `[SMS CONSENT] reconcile enabled=${r.enabled} dry_run=${r.dry_run} ${r.skipped ? `skipped=${r.skipped} ` : ''}` +
    `groups=${r.groups ?? 0} pages=${r.pages ?? 0} listed=${r.listed ?? 0} recorded=${r.recorded ?? 0} ` +
    `would_record=${r.would_record ?? 0} duplicates=${r.duplicates ?? 0} errors=${(r.errors || []).length} | liveness ` +
    (output.liveness || []).map(l => `${l.provider}:${l.silent_hours == null ? 'never' : `${l.silent_hours}h`}${l.alerted ? `(${l.alerted})` : ''}`).join(' ')
  );
  if (failures.length) throw new Error(`sms_consent_sync failed — ${failures.join('; ')}`);
  return { success: true, output };
};

fns.sms_consent_sync.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — driven by the "SMS consent sync" recurring job
  description:
    'Internal: the nightly SMS consent run — (1) the read-only RingCentral consent reconcile: every number ' +
    'RingCentral lists as opted out becomes a provider_optout event in the consent ledger (scope all; never a ' +
    'push to RingCentral), fail-closed on app_settings sms_rc_consent_sync_enabled != "1"; (2) the inbound ' +
    'liveness check: an alert per provider when no inbound text has been ingested for ' +
    'sms_inbound_liveness_hours (default 72). Driven by its recurring job — do not add to workflows. ' +
    'Not CTA-eligible. ref/YISRAMAIL_DESIGN.md §4.6.',
  params: [
    { name: 'dry_run', type: 'boolean', required: false,
      description: 'true = list RingCentral\'s opted-out numbers and count what WOULD be recorded, writing nothing — runs even while sms_rc_consent_sync_enabled is off (the look before turning it on). Never set on the recurring job.' },
  ],
  example: {},
};

module.exports = fns;
