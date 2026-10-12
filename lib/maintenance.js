// lib/maintenance.js
//
/**
 * Maintenance mode — a write freeze for the whole app, switched by one env var.
 *
 *   MAINTENANCE_MODE=1   (set on a Cloud Run revision; unset = this module is inert)
 *
 * WHY IT EXISTS
 *   Moving the database (or any change that needs the data to stand still)
 *   needs a window in which NOTHING writes. Pausing Cloud Scheduler stops the
 *   cron, but every other door is still open: staff, the portal, booking
 *   pages, email buttons, API-key callers, webhooks. This gate closes them all
 *   with an honest 503 — except the one door that must stay open.
 *
 * THE ONE EXEMPTION — POST /hooks/:slug
 *   The hook receiver deliberately answers 200 even when its own pipeline
 *   fails ("our errors must never become sender-side retries"). Under a
 *   frozen database that guarantee turns into silent loss: RingCentral / Quo
 *   call + SMS events, website leads and Calendly all enter there, get their
 *   200, and vanish. So the receiver stays reachable and CAPTURES instead of
 *   executing — see the maintenance branch in routes/api.hooks.js and
 *   lib/hookSpool.js. Everything else either retries on its own (the Gmail
 *   Apps Script keeps its label on a 5xx; scheduled_jobs is a table, so jobs
 *   run late; the mailbox poll resumes from its cursor; esign_reconcile
 *   catches missed Zoho webhooks) or is a person / a response-using API
 *   caller, for whom a faked success would be worse than a clean failure.
 *   (Landing-page form posts — routes/pageLanding.js, "always 303" — are the
 *   same ack-then-work shape, but their sender is a person: the page itself is
 *   not served during the freeze, and a tab left open gets the maintenance
 *   page instead of a thank-you for a lead that went nowhere.)
 *
 * WHAT THE GATE DOES NOT DO
 *   It does not stop writers that never pass through Express: anything
 *   holding direct MySQL credentials (Pabbly, a local dev .env), and this
 *   app's own background paths. The operator closes those separately — pause
 *   the schedulers and the yc-jobs queue, switch off direct-MySQL automations,
 *   and run the maintenance revision on the READ-ONLY database user so a
 *   stray write anywhere in the app fails loudly instead of landing in a
 *   database that is about to be left behind.
 *
 * MOUNT ORDER (server.js) — both halves are load-bearing:
 *   - AFTER cors + the build-header stamp, so a 503 is readable cross-origin
 *     and still carries X-App-Build.
 *   - BEFORE the body parsers, express.static and lib/responseObserver: a
 *     maintenance 503 is not an application error and must not be recorded as
 *     one (the observer would try to INSERT an alert per request — into the
 *     frozen database).
 */

'use strict';

const DEFAULT_RETRY_AFTER_S = 900;
const DEFAULT_MESSAGE =
  'This site is briefly down for scheduled maintenance. Nothing has been lost — please try again in a few minutes.';

// Exactly the public receiver. Not /api/hooks/* (management, JWT) and not a
// deeper path — a new route under /hooks must opt in here deliberately.
// Case-insensitive and trailing-slash tolerant because Express's router is
// (default `case sensitive routing` / `strict routing` are both off): a sender
// configured with /Hooks/x reaches the receiver today and must still reach it
// during a freeze.
const HOOK_RECEIVER_RE = /^\/hooks\/[^/]+\/?$/i;

function isOn(env = process.env) {
  return String(env.MAINTENANCE_MODE == null ? '' : env.MAINTENANCE_MODE).trim() === '1';
}

function retryAfterSeconds(env = process.env) {
  const n = parseInt(env.MAINTENANCE_RETRY_AFTER, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETRY_AFTER_S;
  return Math.min(n, 86400);
}

function message(env = process.env) {
  const m = String(env.MAINTENANCE_MESSAGE == null ? '' : env.MAINTENANCE_MESSAGE).trim();
  return m || DEFAULT_MESSAGE;
}

/** True for the single request shape allowed through the gate. */
function isCapturePath(req) {
  return req.method === 'POST' && HOOK_RECEIVER_RE.test(req.path || '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Self-contained page (no script, no external asset — every other route is
 * closed, so nothing it linked to would load). Reloads itself every minute so
 * a tab left open comes back on its own when the window ends.
 */
function pageHtml(msg) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<meta name="robots" content="noindex">
<title>Down for maintenance</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#f4f5f7;color:#1f2933;
       font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}
  main{max-width:30rem;background:#fff;border:1px solid #d9dee4;border-radius:10px;padding:28px 28px 22px}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{margin:.5rem 0}
  small{color:#5f6c7b}
</style></head>
<body><main>
<h1>Down for maintenance</h1>
<p>${escapeHtml(msg)}</p>
<p><small>This page checks again by itself every minute.</small></p>
</main></body></html>`;
}

/**
 * Express middleware. Inert (one env read, then next()) unless
 * MAINTENANCE_MODE=1. isOn() is evaluated per request rather than captured at
 * mount, so a test — or a future runtime switch — flips it without a remount.
 */
function gate() {
  return function maintenanceGate(req, res, next) {
    if (!isOn()) return next();
    if (isCapturePath(req)) return next();

    const retry = retryAfterSeconds();
    const msg = message();
    res.status(503);
    res.set('Retry-After', String(retry));
    res.set('Cache-Control', 'no-store');

    // A browser navigation gets the page — a GET, or a plain <form> POST from
    // a tab left open on a landing/booking page (routes/pageLanding.js), which
    // would otherwise show its visitor raw JSON. Everything else (apiSend,
    // fetch, curl, webhooks, Cloud Scheduler, Cloud Tasks) gets JSON.
    // req.accepts ranks by the Accept header: browsers navigate with
    // text/html first; `*/*` (fetch, curl, most HTTP clients) → json.
    if (req.accepts(['json', 'html']) === 'html') {
      return res.type('html').send(pageHtml(msg));
    }
    return res.json({ status: 'maintenance', error: 'maintenance', message: msg, retry_after: retry });
  };
}

module.exports = {
  isOn, gate, isCapturePath, retryAfterSeconds, message, pageHtml,
  DEFAULT_RETRY_AFTER_S, DEFAULT_MESSAGE, HOOK_RECEIVER_RE,
};
