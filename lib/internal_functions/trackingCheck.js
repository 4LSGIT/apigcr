// lib/internal_functions/trackingCheck.js
//
// The tracking-domain watchdog (C6c) — a daily scheduled job, the
// mail_bounce_digest pattern: uiHidden plumbing, CTA-denied
// (services/ctaService.js CTA_FN_DENYLIST). It runs no code body, so it has
// no guest-code lane. Probe + verdict live in lib/trackingDomainCheck.js.

const fns = {};

/**
 * tracking_domain_check
 * Fetch the marketing tracking domain the way AWS's doc verifies it, assert
 * the SES headers, read the TLS cert's days-to-expiry, and raise ONE alert
 * per UTC day when something is off: error for a broken/expiring domain and
 * for PERMANENT probe failures (cert chain, dead name); warning for a
 * transient fetch failure, escalated to error when yesterday alerted too
 * (the alert convention — repeated is not transient). Healthy runs alert
 * nothing.
 */
fns.tracking_domain_check = async (params = {}, db) => {
  const { probe, verdictFor, DAYS_MIN } = require('../trackingDomainCheck');   // lazy require (convention)
  const url = params.url || 'https://r.news.4lsg.com/favicon.ico';
  const expectRegion = params.region || 'us-east-2';
  const minDays = params.min_days != null ? Number(params.min_days) : DAYS_MIN;

  let facts;
  try {
    facts = await probe(url, {});
  } catch (err) {
    facts = { error: String((err && err.message) || err), errorCode: (err && err.code) || null };
  }
  const verdict = verdictFor(facts, { expectRegion, minDays });

  let alerted = false;
  if (verdict) {
    const dayKey = (d) => `mail_tracking_domain:${d.toISOString().slice(0, 10)}`;
    const dedupKey = dayKey(new Date());
    const ydayKey = dayKey(new Date(Date.now() - 86_400_000));
    // The alert convention: transient AND first occurrence → warning; a
    // REPEAT is an error (review B1 — a warning never emails, and a
    // "transient" failure still there tomorrow isn't one).
    const [yday] = await db.query('SELECT id FROM system_alerts WHERE dedup_key = ? LIMIT 1', [ydayKey]);
    if (verdict.level === 'warning' && yday.length) {
      verdict.level = 'error';
      verdict.reason += ' (second consecutive day — no longer transient)';
    }
    const [[existing]] = await db.query('SELECT id FROM system_alerts WHERE dedup_key = ? LIMIT 1', [dedupKey]);
    if (!existing) {
      const { alert } = require('../alerting');   // lazy require (convention)
      await alert(db, {
        source: 'mail', kind: 'mail_tracking_domain', group_key: 'mail_tracking_domain',
        severity: verdict.level,
        title: 'Marketing tracking domain check failed',
        message: `${verdict.reason}. Probed ${url}. Every tracking link in every sent marketing email rides this domain; ` +
          'the fix lives in local/2026-11-05_YISRAMAIL_C6_STEP0_RUNBOOK.md and ref/YISRAMAIL_DESIGN.md §6.5 As-built (C6).',
        dedup_key: dedupKey,
      });
      alerted = true;
    }
  }
  return { success: true, output: { ...facts, healthy: !verdict, ...(verdict ? { level: verdict.level, reason: verdict.reason, alerted } : {}) } };
};

fns.tracking_domain_check.__meta = {
  category: 'system',
  uiHidden: true,   // internal plumbing — the daily watchdog job's target only
  description:
    'Internal: daily watchdog for the marketing tracking domain (C6). Fetches https://r.news.4lsg.com/favicon.ico, ' +
    'asserts HTTP 200 + x-amz-ses-region + https request protocol, and reads the TLS certificate\'s days-to-expiry ' +
    '(the cert only auto-renews while the ACM validation CNAME exists — deleting it breaks every sent tracking ' +
    'link ~a year later, silently). One alert per UTC day: error for broken/expiring, warning for a transient ' +
    'fetch failure. Not for workflows; not CTA-eligible.',
  params: [
    { name: 'url', type: 'string', required: false, description: 'Probe URL; default https://r.news.4lsg.com/favicon.ico.' },
    { name: 'region', type: 'string', required: false, description: 'Expected x-amz-ses-region; default us-east-2.' },
    { name: 'min_days', type: 'integer', required: false, description: 'Alert when the cert has fewer days left; default 21 (ACM renews ~60 days out).' },
  ],
  example: {},
};

module.exports = fns;
