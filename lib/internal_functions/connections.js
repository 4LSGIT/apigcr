// lib/internal_functions/connections.js
const emailService   = require('../../services/emailService');
const { getSetting }              = require('../../services/settingsService');
const { buildHeadersForCredential } = require('../credentialInjection');

const fns = {};

// ─────────────────────────────────────────────────────────────
// DEV / TESTING
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// CONNECTIONS / OAUTH
// ─────────────────────────────────────────────────────────────

/**
 * refresh_expiring_oauth_credentials
 * Scan oauth2 credentials and proactively refresh anything whose tokens
 * are near expiry. Designed to run as a daily recurring scheduled job.
 *
 * Selection criteria (OR'd together, status='connected' required):
 *   - refresh_token_expires_at IS NOT NULL AND < NOW() + 48h
 *     (catch refresh tokens about to die so we get a fresh refresh token
 *      via rotation before the existing one expires)
 *   - access_token_expires_at < NOW() + 1h
 *     (catch stale access tokens for credentials that haven't been used
 *      lately by any webhook — lazy refresh on use never fired)
 *
 * Credentials with status pending/failed/refresh_failed/revoked are
 * skipped (refreshing a failed cred would re-fail; refreshing a revoked
 * cred would error).
 *
 * The 2-strike alert and oauth_status='refresh_failed' transition is
 * handled INSIDE oauthService.refreshTokens. This function just iterates
 * and reports counts.
 *
 * params: none
 *
 * example config:
 *   { "function_name": "refresh_expiring_oauth_credentials", "params": {} }
 */

fns.refresh_expiring_oauth_credentials = async (params, db) => {
    // Lazy require — heavy module specific to this one function. Matches
    // the run_task_digest pattern (require its services inline).
    const oauthService = require('../../services/oauthService');

    const [rows] = await db.query(
      `SELECT id, name
         FROM credentials
        WHERE type = 'oauth2'
          AND oauth_status = 'connected'
          AND (
            (refresh_token_expires_at IS NOT NULL
             AND refresh_token_expires_at < NOW() + INTERVAL 48 HOUR)
            OR access_token_expires_at < NOW() + INTERVAL 1 HOUR
          )`
    );

    const results = {
      attempted: rows.length,
      succeeded: 0,
      failed:    0,
      errors:    [],
    };

    console.log(`[REFRESH_EXPIRING_OAUTH] ${rows.length} credentials due for refresh`);

    for (const row of rows) {
      try {
        await oauthService.refreshTokens(db, row.id);
        results.succeeded++;
        console.log(`[REFRESH_EXPIRING_OAUTH] cred ${row.id} (${row.name}) refreshed`);
      } catch (err) {
        results.failed++;
        results.errors.push({ id: row.id, name: row.name, error: err.message });
        // refreshTokens already updates failure_count + alerts at threshold.
        // We just log here so the daily-job output is searchable.
        console.error(
          `[REFRESH_EXPIRING_OAUTH] cred ${row.id} (${row.name}) failed: ${err.message}`
        );
      }
    }

    console.log(
      `[REFRESH_EXPIRING_OAUTH] done — ${results.succeeded}/${results.attempted} refreshed, ${results.failed} failed`
    );

    return { success: true, output: results };
  };

fns.refresh_expiring_oauth_credentials.__meta = {
  category: 'connections',
  description:
    'Refresh oauth2 credentials with tokens expiring soon. Refresh-token cutoff: 48h. ' +
    'Access-token cutoff: 1h (catches stale connections that webhooks haven\'t exercised). ' +
    'Skips non-connected credentials. The 2-strike alert + status flip is handled inside ' +
    'oauthService.refreshTokens — this function just iterates and reports counts.',
  params: [],
  example: {}
};

/**
 * rc_renew_subscriptions
 * Daily idempotent renewal pass over RingCentral webhook subscriptions
 * tracked in app_settings.rc_subscriptions.
 *
 * Storage shape (one JSON-encoded array under key 'rc_subscriptions'):
 *   [{
 *     subscription_id, hook_slug, credential_id,
 *     event_filters: [...],
 *     expires_at: <ISO>,         // mirrors RC's expirationTime
 *     verification_token: <UUID>,
 *     created_at: <ISO>
 *   }, ...]
 *
 * Per-entry behavior:
 *   - expires_at > now + 48h → skip ('not_due')
 *   - else PUT subscription/<id> with body '{}' (RC extends w/ default duration)
 *       · 200 → update expires_at to response.expirationTime ('renewed')
 *       · 404 → remove from array, queue IT alert ('removed_404')
 *       · any other status / network error → log+leave untouched ('error')
 *
 * Idempotent: RC's PUT on a still-active subscription extends it. Multiple
 * runs in a row, or a partial failure mid-loop, leave the system in a
 * consistent state — the next daily pass re-tries any 'error' entries.
 *
 * The app_settings row is only written back when something actually
 * changed (renewed OR removed) — avoids unnecessary writes on no-op runs.
 *
 * params: none
 *
 * example config:
 *   { "function_name": "rc_renew_subscriptions", "params": {} }
 */

fns.rc_renew_subscriptions = async (params, db) => {
    const SUBSCRIPTION_BASE = 'https://platform.ringcentral.com/restapi/v1.0/subscription';
    const RENEW_LEAD_MS     = 48 * 60 * 60 * 1000; // 48h
    const REQUEST_TIMEOUT_MS = 30_000;

    // ── Load and parse the subscriptions blob ────────────────────────
    const raw = await getSetting(db, 'rc_subscriptions');
    if (!raw) {
      console.log('[RC_RENEW] no app_settings.rc_subscriptions row — nothing to do');
      return { success: true, output: { skipped: 'no subscriptions configured' } };
    }

    let subscriptions;
    try {
      subscriptions = JSON.parse(raw);
    } catch (err) {
      console.error(`[RC_RENEW] app_settings.rc_subscriptions is not valid JSON: ${err.message}`);
      return { success: true, output: { skipped: 'malformed rc_subscriptions JSON', error: err.message } };
    }
    if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
      console.log('[RC_RENEW] rc_subscriptions array is empty — nothing to do');
      return { success: true, output: { skipped: 'no subscriptions configured' } };
    }

    console.log(`[RC_RENEW] starting pass over ${subscriptions.length} subscription(s)`);

    const now      = Date.now();
    const results  = [];
    const toRemove = new Set();   // indices into `subscriptions`
    const alerts   = [];          // payloads for IT email after the loop
    let modified   = false;

    // ── Per-entry processing ─────────────────────────────────────────
    for (let i = 0; i < subscriptions.length; i++) {
      const entry = subscriptions[i];
      const tag   = `sub=${entry.subscription_id} slug=${entry.hook_slug}`;

      const expMs = new Date(entry.expires_at).getTime();
      if (!Number.isFinite(expMs)) {
        // Malformed expires_at — treat as immediately due so we either renew it
        // or clear it via the 404 path. Surface it loudly.
        console.warn(`[RC_RENEW] ${tag} has invalid expires_at "${entry.expires_at}" — attempting renewal anyway`);
      } else if (expMs > now + RENEW_LEAD_MS) {
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'not_due',
          expires_at:      entry.expires_at,
        });
        continue;
      }

      const url = `${SUBSCRIPTION_BASE}/${encodeURIComponent(entry.subscription_id)}`;

      // Build auth headers. oauth2 requires the async builder.
      let headers;
      try {
        headers = await buildHeadersForCredential(db, entry.credential_id, url);
      } catch (err) {
        console.error(`[RC_RENEW] ${tag} buildHeadersForCredential threw: ${err.message}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           `header build failed: ${err.message}`,
        });
        continue;
      }
      if (!headers.Authorization) {
        const msg =
          `credential ${entry.credential_id} not connected, or URL ${url} ` +
          `out of allowed_urls scope`;
        console.error(`[RC_RENEW] ${tag} ${msg}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           msg,
        });
        continue;
      }

      // PUT with explicit timeout.
      const controller = new AbortController();
      const tHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, {
          method:  'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body:    '{}',
          signal:  controller.signal,
        });
      } catch (err) {
        // Network error or timeout. Don't mutate the entry; next daily pass retries.
        console.error(`[RC_RENEW] ${tag} PUT threw: ${err.message}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          error:           `network: ${err.message}`,
        });
        continue;
      } finally {
        clearTimeout(tHandle);
      }

      if (res.status === 200) {
        let body;
        try {
          body = await res.json();
        } catch (err) {
          console.error(`[RC_RENEW] ${tag} 200 but JSON parse failed: ${err.message}`);
          results.push({
            subscription_id: entry.subscription_id,
            hook_slug:       entry.hook_slug,
            action:          'error',
            error:           `200 with malformed JSON: ${err.message}`,
          });
          continue;
        }
        const newExpiry = body.expirationTime;
        if (!newExpiry) {
          console.error(`[RC_RENEW] ${tag} 200 missing expirationTime in body`);
          results.push({
            subscription_id: entry.subscription_id,
            hook_slug:       entry.hook_slug,
            action:          'error',
            error:           '200 response missing expirationTime',
          });
          continue;
        }
        entry.expires_at = newExpiry; // mutates the array element
        modified = true;
        console.log(`[RC_RENEW] ${tag} renewed → new expires_at=${newExpiry}`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'renewed',
          new_expires_at:  newExpiry,
        });
      } else if (res.status === 404) {
        // Subscription is gone on RC's side. Remove + alert.
        toRemove.add(i);
        modified = true;
        alerts.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          event_filters:   entry.event_filters,
          credential_id:   entry.credential_id,
        });
        console.warn(`[RC_RENEW] ${tag} 404 — removing from app_settings, queueing IT alert`);
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'removed_404',
        });
      } else {
        const text = await res.text().catch(() => '');
        console.error(
          `[RC_RENEW] ${tag} PUT failed: ${res.status} ${text.slice(0, 500)}`
        );
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'error',
          status:          res.status,
          error:           text.slice(0, 500),
        });
      }
    }

    // ── Persist back to app_settings, only if something changed ──────
    if (modified) {
      const next = subscriptions.filter((_, idx) => !toRemove.has(idx));
      try {
        await db.query(
          'REPLACE INTO app_settings (`key`, `value`) VALUES (?, ?)',
          ['rc_subscriptions', JSON.stringify(next)]
        );
        console.log(
          `[RC_RENEW] wrote back ${next.length} subscription(s) ` +
          `(removed ${toRemove.size}, renewed ${results.filter(r => r.action === 'renewed').length})`
        );
      } catch (err) {
        // Write-back failure is serious — we already mutated nothing on RC
        // (renewal PUTs are idempotent) so the next run will recompute, but
        // surface it loudly.
        console.error(`[RC_RENEW] failed to write back app_settings.rc_subscriptions: ${err.message}`);
        results.push({ action: 'error', error: `app_settings write failed: ${err.message}` });
      }
    }

    // ── IT alerts for removed-404 entries ────────────────────────────
    // Resolved AFTER the renewal loop so a slow / failing email send can't
    // block subsequent RC PUTs in this pass. Email failures are swallowed —
    // the console.error is the durable record, and the next daily pass will
    // not re-alert (the entry is already gone from app_settings).
    if (alerts.length) {
      const fromAddr =
        (await getSetting(db, 'email_automations')) ||
        process.env.AUTO_EMAIL ||
        'automations@4lsg.com';
      const toAddr = (await getSetting(db, 'email_it')) || process.env.IT_EMAIL || 'it@4lsg.com';

      for (const a of alerts) {
        const subject = `RC Subscription removed: ${a.hook_slug}`;
        const body =
          `RingCentral returned 404 for subscription ${a.subscription_id}.\n` +
          `It has been removed from app_settings.rc_subscriptions to stop the daily renewal loop.\n\n` +
          `  subscription_id: ${a.subscription_id}\n` +
          `  hook_slug:       ${a.hook_slug}\n` +
          `  credential_id:   ${a.credential_id}\n` +
          `  event_filters:   ${JSON.stringify(a.event_filters)}\n` +
          `  timestamp:       ${new Date().toISOString()}\n` +
          `  environment:     ${process.env.ENVIRONMENT || 'unknown'}\n\n` +
          `Operator: re-bootstrap this subscription via apiTester per the Slice 6 doc ` +
          `(POST RC create-subscription, then INSERT/UPDATE app_settings.rc_subscriptions).`;

        try {
          await emailService.sendEmail(db, {
            from:    fromAddr,
            to:      toAddr,
            subject,
            text:    body,
          });
          console.log(`[RC_RENEW] IT alert sent for sub=${a.subscription_id} (${a.hook_slug})`);
        } catch (err) {
          console.error(
            `[RC_RENEW] IT alert email failed for sub=${a.subscription_id} (${a.hook_slug}): ${err.message}`
          );
        }
      }
    }

    console.log(
      `[RC_RENEW] done — ${subscriptions.length} considered, ` +
      `${results.filter(r => r.action === 'renewed').length} renewed, ` +
      `${results.filter(r => r.action === 'removed_404').length} removed, ` +
      `${results.filter(r => r.action === 'not_due').length} not_due, ` +
      `${results.filter(r => r.action === 'error').length} error`
    );

    return {
      success: true,
      output: {
        count: subscriptions.length,
        results,
      },
    };
  };

fns.rc_renew_subscriptions.__meta = {
  category: 'connections',
  description:
    'Daily idempotent renewal pass over RC webhook subscriptions tracked in ' +
    'app_settings.rc_subscriptions. Per-entry: skip if >48h to expiry, else ' +
    'PUT subscription/<id> with empty body. 404 → remove + alert IT. Other ' +
    'errors are logged and left for the next daily pass. The app_settings ' +
    'row is only rewritten if something changed. Inert until Slice 6 seeds ' +
    'app_settings.rc_subscriptions — empty/missing array short-circuits with ' +
    'skipped=true. Returns { count, results: [...] } on success.',
  params: [],
  example: {}
};

// --- GOOGLE CONTACTS SYNC ---

fns.gcontacts_sync_pending = async ({ limit = 1000 } = {}, db) => {
  const gcontacts = require('../../services/gContactsService'); // lazy require (convention)
  const result = await gcontacts.syncPending(db, { limit });
  console.log(
    `[GCONTACTS_SYNC] pushed=${result.pushed} created=${result.created} ` +
    `updated=${result.updated} skipped=${result.skipped} errors=${result.errors.length}`
  );
  return result;
};

fns.gcontacts_sync_pending.__meta = {
  category: 'connections',
  description:
    'Nightly drift sweep: pushes YisraCase contacts whose row changed since last sync ' +
    '(contact_updated > contact_google_synced_at) or were never synced, to Google Contacts. ' +
    'Names authoritative; phones/emails union-merged (no deletes); firm-internal domains skipped. ' +
    'Bounded by limit (default 1000, capped 2000). Returns { pushed, created, updated, skipped, errors }.',
  params: [
    { name: 'limit', type: 'number', required: false, default: 1000,
      description: 'Max changed contacts to push per run (capped at 2000).' },
  ],
  example: {}
};

module.exports = fns;
