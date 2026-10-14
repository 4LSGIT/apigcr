// lib/auth.jwtOrApiKey.js
//
// Auth middleware for API routes. Accepts, in order:
//   1. x-api-key === internal key (current OR previous slot) — the app's own
//      self-credential, injected by lib/credentialInjection for self-targeted
//      workflow/hook calls. Resolved via firmConfig:
//      internal_api_key / internal_api_key_prev settings → INTERNAL_API_KEY
//      env fallback. Dual-slot acceptance makes rotation safe across the
//      60s config-cache skew between Cloud Run instances.
//   2. x-api-key matching an active row in api_keys (per-source external
//      keys — see lib/apiKeys.js). req.auth carries the key's label and the
//      audit log records it, so external calls are attributed by name.
//   3. Bearer JWT (unchanged).
// A presented-but-unrecognized x-api-key falls through to the JWT check and,
// absent a Bearer header, 401s — same shape as before.

const jwt = require("jsonwebtoken");
const apiKeys = require("./apiKeys");

// Refresh-on-miss throttle (see the yci_ branch below).
const FORCED_REFRESH_MIN_MS = 2000;
let lastForcedRefreshAt = 0;

// ── URL credential redaction (SEC-1, 2026-10-12) ──────────────────────────
// Stale auto-login bookmarks (/?user=…&pass=…) put plaintext passwords in
// the Referer header of every boot-time API call, and this logger stored
// them raw — readable through the readonly SQL endpoint. Redact the VALUE
// of any credential-shaped query param in every URL-bearing field we log
// (headers.referer and the route/originalUrl), keeping the param name so
// the row stays diagnosable. Conservative name set, exact names only
// (?passenger= / ?bypass= survive), case-insensitive. Same convention as
// the body redaction below: value → "[REDACTED]".
const SENSITIVE_PARAM_NAMES = "password|api_key|apikey|secret|token|pass|pwd|auth|key";
const SENSITIVE_URL_PARAM_RE = new RegExp(
  `([?&](?:${SENSITIVE_PARAM_NAMES})=)[^&#]+`,
  "gi"
);
const SENSITIVE_PARAM_NAME_RE = new RegExp(`^(?:${SENSITIVE_PARAM_NAMES})$`, "i");
function redactUrlParams(url) {
  if (typeof url !== "string") return url;
  return url.replace(SENSITIVE_URL_PARAM_RE, "$1[REDACTED]");
}

async function logJwtApiAttempt(req, authType, username, authStatus) {
  try {
    const logQuery = `
      INSERT INTO jwt_api_audit_log
      (route, method, headers, query_params, body, ip_address, user_agent, auth_type, username, auth_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const headersCopy = { ...req.headers };
    // Redact auth material — do NOT store Bearer tokens or API keys in audit logs
    delete headersCopy.authorization;
    delete headersCopy["x-api-key"];
    delete headersCopy.cookie;
    // Referer carries the FULL URL of the navigating page, credentials-in-URL
    // included (SEC-1). Node lowercases inbound header names, so `referer`
    // is the only key to treat.
    if (headersCopy.referer) headersCopy.referer = redactUrlParams(headersCopy.referer);

    // Redact password-like fields from body. smtp_pass (email-credentials
    // POST/PUT) and imap_secret (mailboxes POST/PATCH) are credential
    // plaintext on the way in — this table is readable by readonly keys.
    const bodyCopy = { ...(req.body || {}) };
    for (const k of ["password", "current_password", "new_password", "api_key", "smtp_pass", "imap_secret"]) {
      if (bodyCopy[k]) bodyCopy[k] = "[REDACTED]";
    }

    // Redact auth-like fields from query string — same name set as the URL
    // redactor above, matched case-insensitively (the old exact-lowercase
    // list missed `pass`, `pwd`, `secret`, `api_key`, `auth` and any
    // capitalized variant).
    const queryCopy = { ...(req.query || {}) };
    for (const k of Object.keys(queryCopy)) {
      if (SENSITIVE_PARAM_NAME_RE.test(k) && queryCopy[k]) queryCopy[k] = "[REDACTED]";
    }

    const params = [
      // originalUrl carries the raw query string; the parsed-query redaction
      // above doesn't reach it (SEC-1).
      redactUrlParams(req.originalUrl),
      req.method,
      JSON.stringify(headersCopy),
      JSON.stringify(queryCopy),
      JSON.stringify(bodyCopy),
      req.headers["x-forwarded-for"]?.split(",").shift() || req.socket?.remoteAddress,
      req.headers["user-agent"] || "unknown",
      authType,
      username || null,
      authStatus
    ];

    // Fire-and-forget logging
    req.db.query(logQuery, params).catch(err => {
      console.error("Failed to log JWT/API attempt:", err.message);
    });
  } catch (err) {
    console.error("Unexpected logging error:", err);
  }
}

async function jwtOrApiKey(req, res, next) {
  try {
    // --- API key check ---
    const apiKey = req.headers["x-api-key"];
    if (apiKey) {
      // Internal key: current or previous slot (deferred require — the
      // firmConfig ↔ startup/db chain must not load at module time here).
      const { cfg } = require("./firmConfig");
      const cur = cfg("internal_api_key");
      const prev = cfg("internal_api_key_prev");
      if ((cur && apiKey === cur) || (prev && apiKey === prev)) {
        req.auth = { type: "api_key", key_label: "internal" };
        logJwtApiAttempt(req, "api_key", "internal", "authorized");
        return next();
      }

      // External per-source key (cached hash lookup; fails closed).
      const rec = await apiKeys.lookup(req.db, apiKey);
      if (rec) {
        // scopes: attached, NOT enforced (access-control B1; B2 makes a
        // scoped yck_ key pass only its route/capability scopes).
        req.auth = { type: "api_key", key_id: rec.id, key_label: rec.label, scopes: rec.scopes ?? null };
        logJwtApiAttempt(req, "api_key", rec.label, "authorized");
        return next();
      }

      // REFRESH-ON-MISS: right after a rotation, an instance whose config
      // cache is up to TTL (60s) stale doesn't know the freshly minted
      // internal key yet — the one direction the prev-slot can't cover.
      // Internal keys are always yci_-prefixed (admin.apiKeys rotate), so on
      // an unrecognized yci_ key, force one awaited config refresh and
      // re-check before rejecting. Throttled so a flood of bogus yci_ keys
      // can't turn auth into a DB hammer; prime() itself is fail-open.
      if (apiKey.startsWith("yci_") && Date.now() - lastForcedRefreshAt > FORCED_REFRESH_MIN_MS) {
        lastForcedRefreshAt = Date.now();
        const fc = require("./firmConfig");
        await fc.prime();
        const cur2 = fc.cfg("internal_api_key");
        const prev2 = fc.cfg("internal_api_key_prev");
        if ((cur2 && apiKey === cur2) || (prev2 && apiKey === prev2)) {
          req.auth = { type: "api_key", key_label: "internal" };
          logJwtApiAttempt(req, "api_key", "internal", "authorized");
          return next();
        }
      }
      // Unrecognized key: fall through to the JWT check (same as before —
      // no Bearer header ⇒ 401).
    }

    // --- JWT check ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logJwtApiAttempt(req, "none", null, "unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Audience guard (Portal Slice 1, defense D1): staff endpoints accept
    // only staff-audience tokens. Legacy staff tokens carry no aud → pass;
    // new staff tokens carry aud:"staff" → pass; portal tokens
    // (aud:"contact") are rejected here as belt-and-braces on top of the
    // user_auth gate below (portal tokens never carry user_auth either).
    if (payload.aud && payload.aud !== "staff") {
      logJwtApiAttempt(req, "jwt", payload.username || payload.sub, "unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!payload.sub || !payload.user_auth || !payload.user_auth.startsWith("authorized")) {
      logJwtApiAttempt(req, "jwt", payload.username || payload.sub, "unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (process.env.JWT_VERSION && payload.ver !== parseInt(process.env.JWT_VERSION)) {
      logJwtApiAttempt(req, "jwt", payload.username || payload.sub, "unauthorized");
      return res.status(401).json({ error: "Token expired (version mismatch)" });
    }

    req.auth = {
      type: "jwt",
      userId: payload.sub,
      username: payload.username,
      user_type: payload.user_type,
      user_auth: payload.user_auth,
      // Roles claim (Portal Slice 1). Legacy tokens have no roles → [] —
      // roles-gated routes (requireAuth, later M-slices) fail closed for
      // them; nothing that mounts plain jwtOrApiKey reads roles today.
      roles: Array.isArray(payload.roles) ? payload.roles : []
    };

    logJwtApiAttempt(req, "jwt", payload.username, "authorized");
    next();
  } catch (err) {
    logJwtApiAttempt(req, "none", null, "invalid_token");
    return res.status(401).json({ error: "Invalid token or API key" });
  }
}

module.exports = jwtOrApiKey;
// Expose the audit logger so lib/auth.requireAuth.js writes the SAME
// jwt_api_audit_log rows (identical redaction) instead of duplicating it.
// module.exports stays a function — the ~30 existing require sites that
// mount it directly are untouched.
module.exports.logJwtApiAttempt = logJwtApiAttempt;
// Exposed for tests (tests/refererRedaction.test.js).
module.exports.redactUrlParams = redactUrlParams;