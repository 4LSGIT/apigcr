// lib/credentialInjection.js
//
// Shared HTTP credential injection for outbound requests. Used by:
//   - services/hookService.js    — YisraHook HTTP targets
//   - lib/sequenceEngine.js      — sequence 'webhook' step type (Slice 3.3)
//   - lib/webhookExecutor.js     — workflow webhook step + scheduled-job webhook
//                                   (via lib/webhookExecutor)
//
// The function body here is lifted from hookService.buildAuthHeaders with
// one signature change: it takes a credential row + destination URL instead
// of a hook-target row with joined cred_* fields. This keeps URL-scope
// validation (credential.allowed_urls) applicable to both call sites — hook
// targets had it, sequence webhook steps inherit it for free.
//
// Credential row shape (matches the `credentials` table):
//   { id, name, type, config, allowed_urls }
//   type ∈ ('internal','bearer','api_key','basic')
//   config / allowed_urls may be JSON strings (mysql2 sometimes returns raw
//   column bytes depending on driver config) or already-parsed objects/arrays.

// ─────────────────────────────────────────────────────────────
// Internal-credential URL-scope check
//
// Before the slice that added webhook credential pickers to workflows and
// scheduled jobs, the only paths that ever reached this module with an
// internal-typed credential were sequence webhook steps and YisraHook HTTP
// targets — and in both cases the operator was generally pointing at our own
// app server. The original implementation skipped the URL-scope check for
// internal creds entirely, which silently allowed `INTERNAL_API_KEY` to leak
// to whatever URL the operator put in.
//
// Fix policy ("option C" per discussion):
//   - If the cred row HAS allowed_urls populated, enforce that (same as
//     non-internal cred types). The operator opted into explicit scoping.
//   - If allowed_urls is empty/missing, fall back to host-equality against
//     APP_URL. This covers the common "talk to ourself" case without forcing
//     every internal cred row to spell out the URL pattern.
//   - If neither matches (no allowed_urls AND APP_URL unset / no match),
//     fail closed — return no header and log a warning.
//
// Non-internal cred types (`bearer`, `api_key`, `basic`) keep their current
// permissive-when-allowed_urls-empty behavior. That's a known leak path the
// operator has signed off on; it's their responsibility to populate
// allowed_urls when creating those rows.
//
// Hostname comparison uses `new URL(...)` parsing rather than string prefix
// matching to defeat the obvious bypass:
//   APP_URL=https://app.4lsg.com → would otherwise match
//   https://app.4lsg.com.evil.com/exfil
// ─────────────────────────────────────────────────────────────

/**
 * Check if `targetUrl` resolves to the same origin as APP_URL.
 *
 * Rules:
 *   - protocol must match (http vs https)
 *   - hostname must match exactly (case-insensitive — handled by URL parser)
 *   - port must match IF APP_URL pins one explicitly; otherwise port is
 *     not enforced (so APP_URL=https://app.4lsg.com matches both
 *     https://app.4lsg.com/foo and https://app.4lsg.com:443/foo)
 *   - path is NOT considered (intent is "talking to ourself", paths add no
 *     security)
 *
 * Returns false on any parse failure or env misconfiguration.
 */
function targetMatchesAppUrl(targetUrl) {
  const appUrl = process.env.APP_URL;
  if (!appUrl || typeof appUrl !== 'string') return false;
  if (!targetUrl || typeof targetUrl !== 'string') return false;

  let target, app;
  try { target = new URL(targetUrl); } catch { return false; }
  try { app    = new URL(appUrl);    } catch { return false; }

  if (target.protocol !== app.protocol) return false;
  if (target.hostname !== app.hostname) return false;
  // Only enforce port when APP_URL specifies one (e.g. http://localhost:3000).
  // URL.port is '' when the URL uses the protocol's default port or omits it.
  if (app.port && target.port !== app.port) return false;

  return true;
}

/**
 * Build HTTP auth headers from a credentials table row.
 *
 * @param {object|null} credential — row from credentials table, or null
 * @param {string}      [url]     — destination URL, used for allowed_urls
 *                                  scope validation. Required for type='internal'
 *                                  (since the fix that closed the leak path);
 *                                  optional but recommended for other types.
 * @returns {object} headers to merge into the outgoing request, or {} if the
 *                   credential is missing/invalid/out-of-scope.
 */
function buildAuthHeaders(credential, url) {
  if (!credential) return {};

  const credType = credential.type;
  // Preserve hookService parse semantics exactly: string → JSON.parse (may throw
  // on malformed config — that's the existing behavior), otherwise pass through.
  const credConfig = typeof credential.config === 'string'
    ? JSON.parse(credential.config) : credential.config;
  const allowedUrls = typeof credential.allowed_urls === 'string'
    ? JSON.parse(credential.allowed_urls) : credential.allowed_urls;

  // ── URL-scope check for non-internal types ──
  // Existing behavior preserved: enforce when allowed_urls is populated;
  // permissive when empty (operator's known-allowed hole).
  if (credType !== 'internal' && Array.isArray(allowedUrls) && allowedUrls.length) {
    if (typeof url !== 'string' || !url.length) {
      console.warn(`[credentialInjection] Credential ${credential.id || '?'} has allowed_urls but no URL was provided — rejecting`);
      return {};
    }
    const matches = allowedUrls.some((pattern) => {
      const regex = new RegExp('^' + String(pattern).replace(/\*/g, '.*') + '$');
      return regex.test(url);
    });
    if (!matches) {
      console.warn(`[credentialInjection] Credential ${credential.id || '?'} not allowed for URL ${url}`);
      return {};
    }
  }

  // ── URL-scope check for internal type — FAIL CLOSED ──
  // INTERNAL_API_KEY is the master key for our own server. It must never leak
  // to a third-party URL, so this block enforces scope unconditionally:
  //   1. If allowed_urls is populated, the non-internal block above has
  //      already validated the match (we just need to skip the second check
  //      below). We use the same allowed_urls check here, applied to
  //      internal too, since the block above had `credType !== 'internal'`.
  //   2. Otherwise fall back to APP_URL host equality.
  // Either path failing → return {} and log.
  if (credType === 'internal') {
    if (typeof url !== 'string' || !url.length) {
      console.warn(`[credentialInjection] Internal credential ${credential.id || '?'} rejected — no URL provided`);
      return {};
    }
    let inScope = false;
    if (Array.isArray(allowedUrls) && allowedUrls.length) {
      inScope = allowedUrls.some((pattern) => {
        const regex = new RegExp('^' + String(pattern).replace(/\*/g, '.*') + '$');
        return regex.test(url);
      });
      if (!inScope) {
        console.warn(`[credentialInjection] Internal credential ${credential.id || '?'} not in allowed_urls for ${url}`);
        return {};
      }
    } else {
      inScope = targetMatchesAppUrl(url);
      if (!inScope) {
        // Distinguish "APP_URL not set" from "URL doesn't match APP_URL" in
        // the log so misconfig is easier to diagnose.
        if (!process.env.APP_URL) {
          console.warn(`[credentialInjection] Internal credential ${credential.id || '?'} rejected — APP_URL env var not set, cannot verify ${url} is self-targeted`);
        } else {
          console.warn(`[credentialInjection] Internal credential ${credential.id || '?'} rejected — ${url} does not match APP_URL (${process.env.APP_URL})`);
        }
        return {};
      }
    }
    // In scope — fall through to the header-building block below.
  }

  if (credType === 'internal') {
    return { 'x-api-key': process.env.INTERNAL_API_KEY };
  }
  if (credType === 'bearer') {
    return { 'Authorization': `Bearer ${credConfig?.token}` };
  }
  if (credType === 'api_key') {
    const header = credConfig?.header || 'x-api-key';
    return { [header]: credConfig?.key };
  }
  if (credType === 'basic') {
    const b64 = Buffer.from(`${credConfig?.username}:${credConfig?.password}`).toString('base64');
    return { 'Authorization': `Basic ${b64}` };
  }

  return {};
}

/**
 * Load a credential row by ID. Returns null for missing/invalid IDs rather
 * than throwing — matches the hookService pattern of silently no-op on
 * missing credentials rather than failing the whole delivery.
 *
 * @param {object} db
 * @param {number|string|null|undefined} credentialId
 * @returns {Promise<object|null>}
 */
async function loadCredential(db, credentialId) {
  if (credentialId == null || credentialId === '') return null;
  const n = Number(credentialId);
  if (!Number.isInteger(n) || n <= 0) return null;

  const [[row]] = await db.query(
    `SELECT id, name, type, config, allowed_urls FROM credentials WHERE id = ?`,
    [n]
  );
  return row || null;
}

/**
 * Convenience: load + build in one call. Returns {} on any miss/invalid —
 * callers can merge the result unconditionally without extra null checks.
 *
 * @param {object} db
 * @param {number|null} credentialId
 * @param {string}      [url] — destination URL, for allowed_urls scope check
 * @returns {Promise<object>} headers
 */
async function buildHeadersForCredential(db, credentialId, url) {
  const cred = await loadCredential(db, credentialId);
  return buildAuthHeaders(cred, url);
}

module.exports = {
  buildAuthHeaders,
  loadCredential,
  buildHeadersForCredential,
};