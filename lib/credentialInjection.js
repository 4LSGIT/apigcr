// lib/credentialInjection.js
//
// Shared HTTP credential injection for outbound requests. Used by:
//   - services/hookService.js    — YisraHook HTTP targets
//   - lib/sequenceEngine.js      — sequence 'webhook' step type (Slice 3.3)
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

/**
 * Build HTTP auth headers from a credentials table row.
 *
 * @param {object|null} credential — row from credentials table, or null
 * @param {string}      [url]     — destination URL, used for allowed_urls
 *                                  scope validation. Ignored for type='internal'.
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

  // URL-scope check. Skip for 'internal' (always allowed to talk to own server).
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