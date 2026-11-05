// lib/trackingDomainCheck.js
//
/**
 * C6c — the tracking-domain watchdog's probe + verdict (the daily
 * tracking_domain_check job, lib/internal_functions/trackingCheck.js).
 *
 * WHY IT EXISTS: every tracking link in every sent marketing email routes
 * through https://r.news.4lsg.com (CloudFront → r.us-east-2.awstrack.me,
 * ACM cert in us-east-1 — design doc §6.5 As-built C6). The cert only
 * auto-renews while the ACM validation CNAME stays in Namecheap; delete it
 * in a DNS cleanup and the cert silently expires ~a year later, breaking
 * every link ever sent, with nothing else noticing. This probe is the
 * noticing: AWS's own verification check (the doc's curl --head
 * …/favicon.ico) plus the TLS cert's days-to-expiry off the socket.
 *
 * SPLIT for testability: probe() does the network; verdictFor() is pure —
 * the decision matrix is unit- and mutation-tested, the network wrapper
 * stays thin.
 */

'use strict';

const https = require('https');

const DAYS_MIN = 21;         // error below this — ACM renews ~60 days out, so 21 means renewal is NOT happening
const TIMEOUT_MS = 10_000;   // bounded, like every external call in a job

/**
 * HEAD-equivalent GET of the tracking domain's favicon (AWS's documented
 * verification path). → { status, region, protocol, daysLeft } — never the
 * body. Throws on network/TLS failure (the verdict treats a throw as
 * transient). daysLeft is null when the socket offers no cert dates.
 */
function probe(url, { timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();   // drain — headers and the socket are all we need
      let daysLeft = null;
      try {
        const cert = res.socket.getPeerCertificate && res.socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          const ms = new Date(cert.valid_to).getTime() - Date.now();
          if (Number.isFinite(ms)) daysLeft = Math.floor(ms / 86_400_000);
        }
      } catch (_) { /* no cert readable → daysLeft stays null */ }
      resolve({
        status: res.statusCode,
        region: res.headers['x-amz-ses-region'] || null,
        protocol: res.headers['x-amz-ses-request-protocol'] || null,
        daysLeft,
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timed out after ${timeoutMs} ms`)); });
    req.on('error', reject);
  });
}

/**
 * Probe throws that are PERMANENT, not transient: a broken cert chain or a
 * dead name never "recovers by tomorrow", so they alert as errors on day one
 * (review B1 — ERR_TLS_CERT_ALTNAME_INVALID is exactly the failure C6 found
 * live, and a deleted CNAME is ENOTFOUND). Anything else (reset, refused,
 * timeout) is a blip until it repeats.
 */
const PERMANENT_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'ENOTFOUND',
]);

/**
 * Pure decision: probe facts → null (healthy) or { level, reason }.
 *   error (a thrown probe)            → error when errorCode is PERMANENT
 *                                       (cert chain / dead name — B1), else
 *                                       warning (transient by convention;
 *                                       the CALLER escalates a repeat — the
 *                                       job raises error when yesterday
 *                                       alerted too)
 *   status ≠ 200                      → error
 *   region ≠ expected (us-east-2)     → error (wrong origin behind the CDN)
 *   protocol ≠ https                  → error (CDN→SES leg downgraded)
 *   daysLeft < minDays                → error (renewal is not happening —
 *                                       the ACM validation CNAME is gone?)
 *   daysLeft null                     → healthy on that axis (no cert date
 *                                       readable through keep-alive reuse —
 *                                       the other checks still ran)
 */
function verdictFor({ error, errorCode, status, region, protocol, daysLeft }, { expectRegion, minDays = DAYS_MIN } = {}) {
  if (!Number.isFinite(minDays)) minDays = DAYS_MIN;   // a bad override must not disable the expiry check (N3)
  if (error) {
    if (PERMANENT_ERROR_CODES.has(errorCode)) return { level: 'error', reason: `probe failed permanently (${errorCode}): ${error}` };
    return { level: 'warning', reason: `probe failed: ${error}` };
  }
  if (status !== 200) return { level: 'error', reason: `HTTP ${status} from the tracking domain (expected 200)` };
  if (region !== expectRegion) return { level: 'error', reason: `x-amz-ses-region is ${region || 'missing'}, expected ${expectRegion} — the CDN origin is wrong` };
  if (String(protocol || '').toLowerCase() !== 'https') return { level: 'error', reason: `x-amz-ses-request-protocol is ${protocol || 'missing'}, expected https` };
  if (daysLeft != null && daysLeft < minDays) {
    return { level: 'error', reason: `the TLS certificate expires in ${daysLeft} day(s) — auto-renewal is not happening; check the ACM validation CNAME in Namecheap (design doc §6.5 As-built C6)` };
  }
  return null;
}

module.exports = { probe, verdictFor, DAYS_MIN, TIMEOUT_MS, PERMANENT_ERROR_CODES };
