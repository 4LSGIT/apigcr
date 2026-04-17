const jwt = require("jsonwebtoken");

async function logJwtApiAttempt(req, authType, username, authStatus) {
  try {
    const logQuery = `
      INSERT INTO jwt_api_audit_log
      (route, method, headers, query_params, body, ip_address, user_agent, auth_type, username, auth_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const headersCopy = { ...req.headers };
    // TEMP: log everything including authorization headers
    // For production: remove sensitive fields like Authorization
    // delete headersCopy.authorization;
    // delete headersCopy["x-api-key"];

    // Redact auth material — do NOT store Bearer tokens or API keys in audit logs
    delete headersCopy.authorization;
    delete headersCopy["x-api-key"];
    delete headersCopy.cookie;

    // Redact password-like fields from body
    const bodyCopy = { ...(req.body || {}) };
    for (const k of ["password", "current_password", "new_password", "api_key"]) {
      if (bodyCopy[k]) bodyCopy[k] = "[REDACTED]";
    }

    // Redact auth-like fields from query string
    const queryCopy = { ...(req.query || {}) };
    for (const k of ["password", "apikey", "token", "key"]) {
      if (queryCopy[k]) queryCopy[k] = "[REDACTED]";
    }

    const params = [
      req.originalUrl,
      req.method,
      JSON.stringify(headersCopy),
      //JSON.stringify(req.query || {}),
      //JSON.stringify(req.body || {}),
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

function jwtOrApiKey(req, res, next) {
  try {
    // --- API key check ---
    const apiKey = req.headers["x-api-key"];
    if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
      req.auth = { type: "api_key" };
      logJwtApiAttempt(req, "api_key", "API_KEY", "authorized");
      return next();
    }

    // --- JWT check ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logJwtApiAttempt(req, "none", null, "unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

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
      user_auth: payload.user_auth
    };

    logJwtApiAttempt(req, "jwt", payload.username, "authorized");
    next();
  } catch (err) {
    logJwtApiAttempt(req, "none", null, "invalid_token");
    return res.status(401).json({ error: "Invalid token or API key" });
  }
}

module.exports = jwtOrApiKey;

