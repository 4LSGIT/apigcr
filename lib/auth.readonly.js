// lib/auth.readonly.js
//
// Middleware for the temp readonly-API-key auth path. Separate from
// jwtOrApiKey because:
//   - it accepts a *different* header (X-Readonly-Api-Key) so the wrong
//     credential type can't accidentally satisfy the wrong route
//   - the keys are DB-backed with per-key expiry/revocation/log, not
//     a single shared env-var like INTERNAL_API_KEY
//
// Sets req.auth = {
//   type:  'readonly_apikey',  // current convention (matches jwtOrApiKey's auth.type)
//   kind:  'readonly_apikey',  // future-shape for the requireAuth refactor
//   keyId,
//   label,
//   scopes,                    // null = legacy full surface; else the key's scope array
//                              // (a child: its EFFECTIVE scopes — see DELEGATION below)
//   expiresAt,                 // Date — the key's own expiry
//   parentKeyId,               // null for a root key; the minting key's id for a child
//   rootKeyId,                 // parentKeyId ?? keyId — what per-identity budgets key on
// }
//
// SURFACE SCOPES (access-control B1, ACCESS_CONTROL_DESIGN §5.2): every route
// mounting readonlyApiKeyAuth also mounts requireKeyScope('<surface>') right
// after it — tests/keyScopes.test.js fails on a mount without one, so a new
// temp route cannot ride in on a key that was never granted it. A key whose
// scopes column is NULL passes every surface (legacy); a scoped key passes
// only the surfaces it lists, and a miss is a 403 that NAMES the scope.
//
// DELEGATION (access-control D1, ACCESS_CONTROL_DESIGN §5.8): a child key
// (parent_key_id set, minted by a keys.mint key) is checked against its parent
// on EVERY request, in the same SELECT: parent revoked → 401
// rejected_parent_revoked, parent expired → 401 rejected_parent_expired, parent
// row missing → treated as revoked. Nothing is written to the child's row (no
// sweep). Its scopes are childEffectiveScopes(own, parent's) — recomputed per
// request, so a narrowed parent narrows its children at once. The SELECT names
// parent_key_id: on a schema without the column it errors and auth fails
// CLOSED (500) — the D1 migration runs before the D1 backend.
//
// Auth failures (missing/invalid/expired/revoked key) log a row to
// admin_audit_log via auditAdminAction so attempts are visible to SU.
// Successful calls do NOT log here — the per-query row in
// readonly_query_log carries the audit weight for queries.

const crypto = require("crypto");
const { auditAdminAction } = require("./auth.superuser");
const { KEY_SCOPES, keyAllows, scopesFromColumn, childEffectiveScopes } = require("./capabilities");

// A session key's hashable identity is only "ycro_<body>" — the first two
// underscore-delimited segments (body: 22 base62 since access-control B3, 64 hex
// before; neither contains an underscore). Everything after the second underscore
// is a free-form, advisory suffix (an expiry stamp, a human note, or nothing) that
// a holder may edit or drop without invalidating the key. These are all the same key:
//   ycro_<body>
//   ycro_<body>_20260720T1654Z
//   ycro_<body>_NOTE-goes here_BLA_BLA_BLA
function canonicalKey(plain) {
  const s = String(plain);
  const firstUnderscore  = s.indexOf("_");
  if (firstUnderscore === -1) return s;
  const secondUnderscore = s.indexOf("_", firstUnderscore + 1);
  return secondUnderscore === -1 ? s : s.slice(0, secondUnderscore);
}

// Hashes the canonical identity only, so the stored key_hash and the auth-time
// lookup both ignore the advisory suffix. This is the single source of truth for
// key identity — canonicalizing here keeps create and check in lockstep.
function hashKey(plain) {
  return crypto.createHash("sha256").update(canonicalKey(plain)).digest("hex");
}

const ipOf = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress;

async function logAuthReject(req, status, extra = {}) {
  try {
    await auditAdminAction(req.db, {
      tool: "readonlyKeys",
      userId: null,
      username: null,
      route: req.originalUrl,
      method: req.method,
      status,
      ip: ipOf(req),
      userAgent: req.headers["user-agent"] || "unknown",
      details: extra,
    });
  } catch (err) {
    console.error("[auth.readonly] audit log failed:", err.message);
  }
}

async function readonlyApiKeyAuth(req, res, next) {
  const raw = req.headers["x-readonly-api-key"];
  if (!raw || typeof raw !== "string") {
    await logAuthReject(req, "rejected_no_key");
    return res.status(401).json({ error: "Readonly API key required (X-Readonly-Api-Key header)" });
  }

  let row;
  try {
    const [rows] = await req.db.query(
      `SELECT k.id, k.label, k.expires_at, k.revoked_at, k.scopes, k.parent_key_id,
              p.id AS parent_id, p.expires_at AS parent_expires_at,
              p.revoked_at AS parent_revoked_at, p.scopes AS parent_scopes
         FROM readonly_api_keys k
         LEFT JOIN readonly_api_keys p ON p.id = k.parent_key_id
        WHERE k.key_hash = ?
        LIMIT 1`,
      [hashKey(raw)]
    );
    row = rows[0];
  } catch (err) {
    console.error("[auth.readonly] lookup failed:", err.message);
    return res.status(500).json({ error: "Auth lookup failed" });
  }

  if (!row) {
    await logAuthReject(req, "rejected_unknown_key", { keyPrefix: String(raw).slice(0, 12) });
    return res.status(401).json({ error: "Invalid readonly API key" });
  }
  if (row.revoked_at) {
    await logAuthReject(req, "rejected_revoked", { keyId: row.id });
    return res.status(401).json({ error: "Readonly API key revoked" });
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await logAuthReject(req, "rejected_expired", { keyId: row.id });
    // Safe to disclose: the caller already proved possession of the key.
    return res.status(401).json({
      error: "Readonly API key expired",
      expiredAt: new Date(row.expires_at).toISOString(),
    });
  }

  // A child dies with its parent. A missing parent row (hard-deleted despite
  // the RESTRICT foreign key) counts as revoked — never as "no parent".
  const isChild = row.parent_key_id != null;
  if (isChild && (row.parent_id == null || row.parent_revoked_at)) {
    await logAuthReject(req, "rejected_parent_revoked", { keyId: row.id, parentKeyId: row.parent_key_id });
    return res.status(401).json({ error: "Readonly API key's parent key revoked" });
  }
  if (isChild && new Date(row.parent_expires_at).getTime() < Date.now()) {
    await logAuthReject(req, "rejected_parent_expired", { keyId: row.id, parentKeyId: row.parent_key_id });
    return res.status(401).json({ error: "Readonly API key's parent key expired" });
  }

  req.auth = {
    type:  "readonly_apikey",
    kind:  "readonly_apikey",
    keyId: row.id,
    label: row.label,
    scopes: isChild
      ? childEffectiveScopes(row.scopes, row.parent_scopes)
      : scopesFromColumn(row.scopes),
    expiresAt: new Date(row.expires_at),
    parentKeyId: isChild ? row.parent_key_id : null,
    rootKeyId:   isChild ? row.parent_key_id : row.id,
  };

  // Fire-and-forget usage counter — never block the request on this.
  req.db.query(
    `UPDATE readonly_api_keys
        SET last_used_at = NOW(), use_count = use_count + 1
      WHERE id = ?`,
    [row.id]
  ).catch(err => console.error("[auth.readonly] usage counter update failed:", err.message));

  next();
}

/**
 * requireKeyScope(scope) → middleware, mounted right after readonlyApiKeyAuth.
 * `scope` must be a SURFACE scope (KEY_SCOPES) — anything else throws at
 * mount, loudly. A key without it gets a 403 naming the missing scope (these
 * keys are developer-facing: a bare 403 wastes a session's time), audited
 * like the other key rejections.
 */
function requireKeyScope(scope) {
  if (!Object.prototype.hasOwnProperty.call(KEY_SCOPES, scope)) {
    throw new Error(`requireKeyScope: unknown surface scope ${JSON.stringify(scope)}`);
  }
  return async function keyScopeCheck(req, res, next) {
    if (keyAllows(req.auth, scope)) return next();
    await logAuthReject(req, "rejected_scope", { keyId: req.auth?.keyId ?? null, scope });
    return res.status(403).json({
      error: `Readonly API key lacks the '${scope}' scope`,
      missingScope: scope,
      keyScopes: req.auth?.scopes ?? null,
    });
  };
}

module.exports = { readonlyApiKeyAuth, requireKeyScope, hashKey, canonicalKey };