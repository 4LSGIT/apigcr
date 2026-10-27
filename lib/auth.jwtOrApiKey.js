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
const { shapeTop } = require("./auditShape");
const { routeAllowed } = require("./capabilities");
const { actorFromPayload, auditIdentity, isViewAsPayload, rejectReadonlyViewAsWrite } = require("./auth.impersonation");

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
// (?passenger= / ?bypass= survive), case-insensitive: value → "[REDACTED]".
// (The parsed query and the body are stored as value SHAPES — SEC-2 — so
// these URL rules matter for the two URL strings: the route and the Referer.)
const SENSITIVE_PARAM_NAMES = "password|api_key|apikey|secret|token|pass|pwd|auth|key";
const SENSITIVE_URL_PARAM_RE = new RegExp(
  `([?&](?:${SENSITIVE_PARAM_NAMES})=)[^&#]+`,
  "gi"
);
function redactUrlParams(url) {
  if (typeof url !== "string") return url;
  return url.replace(SENSITIVE_URL_PARAM_RE, "$1[REDACTED]");
}

// ── Search-term redaction (access-control B2 addendum, 2026-10-14) ────────
// DELIBERATELY SEPARATE from the credential list above: `q` is not a
// credential, it is what a person typed into a search box (a client's name,
// a phone number, a phrase from an email). The table left the session-key
// surface at the B2 landing (lib/sqlGuard SECRET_TABLES), but the SU console
// still reads it. The value goes, the name stays, same "[REDACTED]" convention,
// in the two URL strings (route, Referer).
// Exact name `q` only: it is the one free-text search parameter the routes
// read (api.search, api.mail messages, the case/contact pickers; audit log:
// 471 rows in 30 days) — no route reads `search` / `query`, and redacting
// generic words would blind diagnostics. Exact-name match, so ?quality= /
// ?quick= survive; case-insensitive (?Q= costs nothing to cover).
const SEARCH_PARAM_NAMES = "q";
const SEARCH_URL_PARAM_RE = new RegExp(`([?&](?:${SEARCH_PARAM_NAMES})=)[^&#]+`, "gi");
function redactSearchParams(url) {
  if (typeof url !== "string") return url;
  return url.replace(SEARCH_URL_PARAM_RE, "$1[REDACTED]");
}

// Header names whose VALUE is a credential (Node lowercases inbound names):
// authorization, cookie, x-api-key, x-su-elevation, x-readonly-api-key,
// x-badge-token, x-email-ingest-key, x-streak-auth, … — and future kin.
// Exact names first for credentials whose name doesn't say so
// (x-streak-admin is api.streak's admin secret).
const CREDENTIAL_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-streak-admin)$|key|token|secret|auth|elevation|password|session/i;

async function logJwtApiAttempt(req, authType, username, authStatus) {
  try {
    const logQuery = `
      INSERT INTO jwt_api_audit_log
      (route, method, headers, query_params, body, ip_address, user_agent, auth_type, username, auth_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const headersCopy = { ...req.headers };
    // Redact auth material — do NOT store Bearer tokens or API keys in audit logs.
    // By NAME, not a list of the headers we know: x-su-elevation (the SU
    // step-up token) was missing from the old three-name list and sat in
    // 8,926 rows (2026-08-16 → 10-27). Any header whose name says
    // credential is dropped, so a new auth header can't repeat that.
    for (const name of Object.keys(headersCopy)) {
      if (CREDENTIAL_HEADER_RE.test(name)) delete headersCopy[name];
    }
    // Referer carries the FULL URL of the navigating page, credentials-in-URL
    // included (SEC-1). Node lowercases inbound header names, so `referer`
    // is the only key to treat.
    if (headersCopy.referer) headersCopy.referer = redactSearchParams(redactUrlParams(headersCopy.referer));

    // Body and parsed query: KEYS kept, VALUES replaced by type/length shapes
    // (SEC-2, lib/auditShape) — "[str 11]", "[arr 3]", "[obj 4]", one level;
    // credential-named keys are "[secret]" (no length). This replaced the
    // field-name redaction lists: no request value reaches the row at all,
    // so there is no list of dangerous names to keep complete.
    const bodyShape = shapeTop(req.body);
    const queryShape = shapeTop(req.query);

    const params = [
      // originalUrl carries the raw query string; the parsed-query redaction
      // above doesn't reach it (SEC-1).
      redactSearchParams(redactUrlParams(req.originalUrl)),
      req.method,
      JSON.stringify(headersCopy),
      JSON.stringify(queryShape),
      JSON.stringify(bodyShape),
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
        req.auth = { type: "api_key", key_id: rec.id, key_label: rec.label, scopes: rec.scopes ?? null };
        // ROUTE SCOPES (access-control B2, ACCESS_CONTROL_DESIGN §5.2): a key
        // whose scopes column is NULL keeps the legacy full surface; a SCOPED
        // key reaches only paths its route:/ scopes cover (lib/capabilities
        // routeAllowed). The scopes came with the cached lookup — no extra
        // read. Exception: a capability-gated requireAuth mount marks the
        // request (req._keyCapabilityGate) and judges the key by can() itself,
        // so a capability scope reaches its routes without a route scope.
        // Out of scope = 403 (the key IS known; this is authorization),
        // audited as forbidden_scope under the key's label.
        if (rec.scopes != null && !req._keyCapabilityGate) {
          const path = String(req.originalUrl || req.url || "").split("?")[0];
          if (!routeAllowed(req.auth, path)) {
            logJwtApiAttempt(req, "api_key", rec.label, "forbidden_scope");
            return res.status(403).json({ error: "API key is not scoped for this route", path });
          }
        }
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
      { const who = auditIdentity(payload); logJwtApiAttempt(req, who.authType, who.username, "unauthorized"); }
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!payload.sub || !payload.user_auth || !payload.user_auth.startsWith("authorized")) {
      { const who = auditIdentity(payload); logJwtApiAttempt(req, who.authType, who.username, "unauthorized"); }
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (process.env.JWT_VERSION && payload.ver !== parseInt(process.env.JWT_VERSION)) {
      { const who = auditIdentity(payload); logJwtApiAttempt(req, who.authType, who.username, "unauthorized"); }
      return res.status(401).json({ error: "Token expired (version mismatch)" });
    }

    if (rejectReadonlyViewAsWrite(req, res, payload, logJwtApiAttempt)) return;

    const impersonator = actorFromPayload(payload);

    req.auth = {
      type: "jwt",
      userId: payload.sub,
      username: payload.username,
      user_type: payload.user_type,
      user_auth: payload.user_auth,
      // Roles claim (Portal Slice 1). Legacy tokens have no roles → [] —
      // roles-gated routes (requireAuth, later M-slices) fail closed for
      // them; nothing that mounts plain jwtOrApiKey reads roles today.
      roles: Array.isArray(payload.roles) ? payload.roles : [],
      ...(impersonator ? { impersonator } : {}),
      // Any view_as token, even one whose act claim is malformed (then it
      // carries no impersonator): lets routes refuse nesting fail-closed.
      ...(isViewAsPayload(payload) ? { viewAs: true } : {}),
    };

    // View-as rows carry auth_type jwt_view_as[_live] and "target [by actor#id]".
    const who = auditIdentity(payload);
    logJwtApiAttempt(req, who.authType, who.username, "authorized");
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
// Exposed for tests (tests/refererRedaction.test.js, tests/searchRedaction.test.js).
module.exports.redactUrlParams = redactUrlParams;
module.exports.redactSearchParams = redactSearchParams;
module.exports.CREDENTIAL_HEADER_RE = CREDENTIAL_HEADER_RE;
