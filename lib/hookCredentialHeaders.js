// lib/hookCredentialHeaders.js
//
/**
 * Which request headers carry a hook's credential, and how to keep them out
 * of everything YisraHook stores (2026-11-02).
 *
 * The receiver puts each event's headers into its unified input, and that
 * input is persisted: hook_executions.raw_input, hooks.captured_sample, the
 * maintenance spool, and — through a passthrough transform —
 * hook_executions.transform_output and hook_delivery_logs.request_body. Until
 * this module only x-api-key / authorization / cookie were dropped, so the
 * api_key auth's DEFAULT header (x-hook-key) and RingCentral's
 * Verification-Token sat in ~32.8k execution rows readable by any read-only
 * session key (found by YisraMail T2; scrubbed by
 * scripts/hookExecutionsHeaderScrub.js).
 *
 * Credential headers stripped from ANY hook's input = STATIC_CREDENTIAL_HEADERS
 * (every name any hook auth reads by default, plus the generic ones) ∪ the
 * hook's own auth_config.header ∪ every hook's configured header, active or
 * not (configuredHeaderNames — names are not secret). The union matters for an
 * UNMATCHED event: a POST to a deactivated or mistyped slug falls to the
 * `_catchall` hook (auth none), whose own config names nothing, while the
 * request still carries the intended hook's credential. Matched
 * case-insensitively. Dependency-free on purpose (the db is passed in):
 * routes/api.hooks.js and services/hookService.js both require it, and tests
 * that jest.mock hookService with a partial factory must not lose it.
 *
 * The union is cached per process for UNION_TTL_MS (30 s) and only ever
 * GROWS within a process (a name seen once stays stripped); a hook save
 * invalidates the cache in this process (hookService createHook / updateHook /
 * duplicateHook),
 * other instances converge within the TTL. A hook deleted before the process
 * started is unknown to it — its custom name, if not a static one, is not
 * stripped from an event for its old slug (a known residual).
 */

'use strict';

/** services/hookService.authenticateRequest's defaults — one source for both. */
const DEFAULT_API_KEY_HEADER = 'x-hook-key';
const DEFAULT_HMAC_HEADER = 'x-signature';

const STATIC_CREDENTIAL_HEADERS = Object.freeze([
  'x-api-key', 'authorization', 'cookie',
  DEFAULT_API_KEY_HEADER, DEFAULT_HMAC_HEADER,
  'verification-token',
]);

/** auth_config as stored (mysql2 parses JSON columns; a string is tolerated). */
function authConfigOf(hook) {
  const raw = hook && hook.auth_config;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (_) { return null; }
  }
  return typeof raw === 'object' ? raw : null;
}

/** → Set of lowercase header names: the statics, this hook's own header, and `extra` (the union). */
function credentialHeaderNames(hook, extra = null) {
  const names = new Set(STATIC_CREDENTIAL_HEADERS);
  const cfg = authConfigOf(hook);
  if (cfg && typeof cfg.header === 'string' && cfg.header.trim()) names.add(cfg.header.trim().toLowerCase());
  if (extra) for (const n of extra) names.add(String(n).toLowerCase());
  return names;
}

// ── The union of every hook's configured header (cached) ──
const UNION_TTL_MS = 30000;
const UNION_SQL = "SELECT JSON_UNQUOTE(JSON_EXTRACT(auth_config, '$.header')) AS header FROM hooks WHERE auth_config IS NOT NULL";
const union = { names: new Set(), at: 0, inflight: null };

/** Add the configured header names in `rows` ([{header}]) to a Set. */
function addHeaderNames(set, rows) {
  for (const r of Array.isArray(rows) ? rows : []) {
    const h = r && r.header;
    if (typeof h === 'string' && h.trim() && h !== 'null') set.add(h.trim().toLowerCase());
  }
  return set;
}

/**
 * Every hook's configured header name, lowercased (cached, growing). Fails
 * SOFT: a failed read keeps the names already known (the statics and the
 * event's own hook still apply) and is retried on the next call.
 */
async function configuredHeaderNames(db) {
  if (Date.now() - union.at < UNION_TTL_MS) return union.names;
  if (!union.inflight) {
    union.inflight = (async () => {
      try {
        const [rows] = await db.query(UNION_SQL);
        addHeaderNames(union.names, rows);
        union.at = Date.now();
      } catch (err) {
        console.warn(`[hook] configured header names could not be read: ${err && err.message}`);
      } finally {
        union.inflight = null;
      }
    })();
  }
  await union.inflight;
  return union.names;
}

/** A hook was saved in this process: re-read the union on the next call. */
function invalidateConfiguredHeaderNames() { union.at = 0; }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A copy of `headers` without the credential headers (any case); a non-object → {}. */
function stripCredentialHeaders(headers, hook, extra = null) {
  if (!isPlainObject(headers)) return {};
  const names = credentialHeaderNames(hook, extra);
  const out = {};
  for (const k of Object.keys(headers)) {
    if (names.has(String(k).toLowerCase())) continue;
    out[k] = headers[k];
  }
  return out;
}

/** The unified input with its headers stripped (a non-object `headers` → {}); input without a headers key is returned as is. */
function scrubInputHeaders(input, hook, extra = null) {
  if (!isPlainObject(input) || !Object.prototype.hasOwnProperty.call(input, 'headers')) return input;
  return { ...input, headers: stripCredentialHeaders(input.headers, hook, extra) };
}

/**
 * JSON paths (MySQL syntax) of every credential-named key found inside an
 * object stored under a key named `headers` (any case), at any depth of
 * `doc`. For the history scrub: the removal itself is done by JSON_REMOVE on
 * the stored document, so nothing else in it is re-serialized.
 */
function credentialHeaderPaths(doc, names) {
  const paths = [];
  const q = (k) => JSON.stringify(String(k));
  (function walk(node, path, underHeaders) {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, false));
      return;
    }
    if (!isPlainObject(node)) return;
    for (const k of Object.keys(node)) {
      const p = `${path}.${q(k)}`;
      if (underHeaders && names.has(String(k).toLowerCase())) { paths.push(p); continue; }
      walk(node[k], p, String(k).toLowerCase() === 'headers');
    }
  })(doc, '$', false);
  return paths;
}

module.exports = {
  DEFAULT_API_KEY_HEADER,
  DEFAULT_HMAC_HEADER,
  STATIC_CREDENTIAL_HEADERS,
  credentialHeaderNames,
  configuredHeaderNames,
  invalidateConfiguredHeaderNames,
  addHeaderNames,
  UNION_SQL,
  UNION_TTL_MS,
  stripCredentialHeaders,
  scrubInputHeaders,
  credentialHeaderPaths,
};
