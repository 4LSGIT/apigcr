// lib/internal_functions/connections.js
const emailService   = require('../../services/emailService');
const { getSetting }              = require('../../services/settingsService');
const { cfg }                     = require('../firmConfig');
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
 *   - STATUS CHECK, every entry, every pass: GET subscription/<id>
 *       · 200 → read `status`; anything but 'Active' (RC: 'Blacklisted' with
 *         blacklistedData {reason, blacklistedAt}, or 'Suspended') queues an
 *         ERROR alert (below) — the result row carries rc_status either way
 *       · 404 → the subscription is gone: same as the renewal 404 below
 *       · any other status / network error → logged on the result
 *         (status_check_error) and the pass carries on to the renewal logic
 *   - expires_at > now + 48h → skip ('not_due')
 *   - else PUT subscription/<id> with body '{}' (RC extends w/ default duration)
 *       · 200 → update expires_at to response.expirationTime ('renewed'); the
 *         response's `status` is checked exactly as the GET's
 *       · 404 → remove from array, queue IT alert ('removed_404')
 *       · any other status / network error → log+leave untouched ('error')
 *
 * WHY THE STATUS CHECK (2026-10-27). RingCentral BLACKLISTS a webhook
 * subscription whose deliveries fail or time out (3 s) for ~10 minutes. It
 * sends no notice, keeps no undelivered events, and per its current docs the
 * subscription never recovers: delete it and create a new one. Renewal alone
 * would not notice for up to 5 days (a 7-day subscription is PUT only inside
 * its last 48 h — and a blacklisted one may still answer a PUT). The GET is 3
 * calls a day (3 live subscriptions, ~70 ms each).
 *
 * INACTIVE ALERT: severity 'error' (non-transient — RC does not un-blacklist;
 * CLAUDE.md alert severity convention), group_key
 * rc_subscription:<subscription_id>, dedup_key
 * rc_subscription_inactive:<subscription_id>:<UTC date> — at most ONE row per
 * subscription per day however often the job runs (alert() INSERT IGNOREs a
 * repeated dedup_key), so a dead subscription re-alerts daily until it is
 * replaced, never every tick. The subscription is left in the array: deleting
 * and re-creating it is an operator step (manual/04-Integrations/
 * 03-rc-subscription-bootstrap.md, Failure mode 4).
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
    const inactive = new Map();   // subscription_id → payload for the error alert after the loop
    let modified   = false;

    // One RC call with the pass's timeout. Never throws: { httpStatus, body }
    // for a 200 with a JSON body, { httpStatus, error } for anything else.
    const rcRequest = async (method, url, headers) => {
      const controller = new AbortController();
      const tHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const r = await fetch(url, { method, headers, signal: controller.signal });
        if (r.status !== 200) {
          const text = await r.text().catch(() => '');
          return { httpStatus: r.status, error: `${r.status} ${text.slice(0, 300)}` };
        }
        try {
          return { httpStatus: 200, body: await r.json() };
        } catch (err) {
          return { httpStatus: 200, error: `200 with malformed JSON: ${err.message}` };
        }
      } catch (err) {
        return { httpStatus: null, error: `network: ${err.message}` };
      } finally {
        clearTimeout(tHandle);
      }
    };

    // Read RC's `status` off a subscription resource; anything but 'Active'
    // queues the inactive alert (one per subscription per pass — the GET and
    // the renewal answer fold into one). Returns the status (null if absent:
    // logged, not alerted — an absent field is not evidence of a dead
    // subscription, and RC always sends it).
    const noteStatus = (entry, body, where) => {
      const st = body && typeof body.status === 'string' ? body.status : null;
      if (st === null) {
        console.warn(`[RC_RENEW] sub=${entry.subscription_id} slug=${entry.hook_slug} ${where}: no status in RC's answer`);
        return null;
      }
      if (st !== 'Active' && !inactive.has(entry.subscription_id)) {
        const bl = body.blacklistedData && typeof body.blacklistedData === 'object' ? body.blacklistedData : {};
        inactive.set(entry.subscription_id, {
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          credential_id:   entry.credential_id,
          status:          st,
          reason:          bl.reason != null ? String(bl.reason) : null,
          blacklisted_at:  bl.blacklistedAt != null ? String(bl.blacklistedAt) : null,
          seen_in:         where,
        });
        console.error(`[RC_RENEW] sub=${entry.subscription_id} slug=${entry.hook_slug} is ${st}` +
          `${bl.reason ? ` (${bl.reason})` : ''} — RC delivers nothing on it; queueing error alert`);
      }
      return st;
    };

    // 404 from RC (status check or renewal): the subscription is gone on RC's
    // side. Remove + alert.
    const removeGone = (i, entry) => {
      toRemove.add(i);
      modified = true;
      alerts.push({
        subscription_id: entry.subscription_id,
        hook_slug:       entry.hook_slug,
        event_filters:   entry.event_filters,
        credential_id:   entry.credential_id,
      });
      console.warn(`[RC_RENEW] sub=${entry.subscription_id} slug=${entry.hook_slug} 404 — removing from app_settings, queueing IT alert`);
      results.push({
        subscription_id: entry.subscription_id,
        hook_slug:       entry.hook_slug,
        action:          'removed_404',
      });
    };

    // ── Per-entry processing ─────────────────────────────────────────
    for (let i = 0; i < subscriptions.length; i++) {
      const entry = subscriptions[i];
      const tag   = `sub=${entry.subscription_id} slug=${entry.hook_slug}`;

      const expMs = new Date(entry.expires_at).getTime();
      if (!Number.isFinite(expMs)) {
        // Malformed expires_at — treat as immediately due so we either renew it
        // or clear it via the 404 path. Surface it loudly.
        console.warn(`[RC_RENEW] ${tag} has invalid expires_at "${entry.expires_at}" — attempting renewal anyway`);
      }
      const due = !Number.isFinite(expMs) || expMs <= now + RENEW_LEAD_MS;

      const url = `${SUBSCRIPTION_BASE}/${encodeURIComponent(entry.subscription_id)}`;

      // Build auth headers (every entry now — the status check below needs
      // them too). oauth2 requires the async builder.
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

      // ── Status check (GET) — catches a blacklisted subscription days
      // before its renewal would. See WHY THE STATUS CHECK above.
      const check = await rcRequest('GET', url, headers);
      let rcStatus;
      let statusCheckError;
      if (check.httpStatus === 404) {
        removeGone(i, entry);
        continue;
      }
      if (check.body) {
        rcStatus = noteStatus(entry, check.body, 'status check');
      } else {
        statusCheckError = check.error;
        console.error(`[RC_RENEW] ${tag} status check failed: ${check.error}`);
      }
      const checked = {
        ...(rcStatus !== undefined ? { rc_status: rcStatus } : {}),
        ...(statusCheckError ? { status_check_error: statusCheckError } : {}),
      };

      if (!due) {
        results.push({
          subscription_id: entry.subscription_id,
          hook_slug:       entry.hook_slug,
          action:          'not_due',
          expires_at:      entry.expires_at,
          ...checked,
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
          ...checked,
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
        // The renewal answer is the subscription resource too: a status that
        // turned since the GET (or a GET that failed) is caught here.
        const renewedStatus = noteStatus(entry, body, 'renewal');
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
          ...checked,
          ...(renewedStatus !== undefined ? { rc_status: renewedStatus } : {}),
        });
      } else if (res.status === 404) {
        removeGone(i, entry);
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
          ...checked,
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
      // cfg() = email_automations / email_it setting with AUTO_EMAIL /
      // IT_EMAIL env fallback (cached — see lib/firmConfig.js).
      const fromAddr = cfg('email_automations') || 'automations@4lsg.com';
      const toAddr   = cfg('email_it') || 'it@4lsg.com';

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

    // ── ERROR alerts for subscriptions RC no longer delivers on ────────
    // After the loop (an alert write must not hold up the next RC call).
    // alert() never throws; the daily dedup_key folds re-runs into one row.
    if (inactive.size) {
      const { alert } = require('../alerting'); // lazy require (circular-dep safety convention)
      const day = new Date().toISOString().slice(0, 10);
      for (const a of inactive.values()) {
        await alert(db, {
          source:    'connections',
          kind:      'rc_subscription_inactive',
          severity:  'error',
          group_key: `rc_subscription:${a.subscription_id}`,
          dedup_key: `rc_subscription_inactive:${a.subscription_id}:${day}`,
          title:     `RingCentral subscription ${a.status}: hook ${a.hook_slug} receives no RingCentral events`,
          message:
            `RingCentral reports subscription ${a.subscription_id} (hook "${a.hook_slug}") as ${a.status}` +
            `${a.reason ? ` — reason: ${a.reason}` : ''}${a.blacklisted_at ? `, since ${a.blacklisted_at}` : ''}. ` +
            `RingCentral delivers no events on it, keeps none for later, and does not recover it on its own; renewal does not fix it. ` +
            `Recovery: DELETE the subscription on RingCentral, POST a new one for the same hook (same verification token), ` +
            `then replace its entry in app_settings.rc_subscriptions — manual/04-Integrations/03-rc-subscription-bootstrap.md, Failure mode 4. ` +
            `Events sent while it was dead are lost on RingCentral's side.`,
          context: a,
        });
      }
    }

    console.log(
      `[RC_RENEW] done — ${subscriptions.length} considered, ` +
      `${results.filter(r => r.action === 'renewed').length} renewed, ` +
      `${results.filter(r => r.action === 'removed_404').length} removed, ` +
      `${results.filter(r => r.action === 'not_due').length} not_due, ` +
      `${results.filter(r => r.action === 'error').length} error, ` +
      `${inactive.size} not Active`
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
    'errors are logged and left for the next daily pass. Every pass also GETs ' +
    'each subscription: a status other than Active (Blacklisted / Suspended) ' +
    'raises an error alert, at most once per subscription per day — recovery ' +
    'is delete + recreate. The app_settings ' +
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
