const jwt = require("jsonwebtoken");

function jwtOrApiKey(req, res, next) {
  try {
    // --- API key check ---
    const apiKey = req.headers["x-api-key"];
    if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
      req.auth = { type: "api_key" };
      return next();
    }

    // --- JWT check ---
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Defensive check
    if (!payload.sub || !payload.user_auth || !payload.user_auth.startsWith("authorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Optional: global version-based logout
    if (process.env.JWT_VERSION && payload.ver !== parseInt(process.env.JWT_VERSION)) {
      return res.status(401).json({ error: "Token expired (version mismatch)" });
    }

    // Attach auth info
    req.auth = {
      type: "jwt",
      userId: payload.sub,
      username: payload.username,
      user_type: payload.user_type,
      user_auth: payload.user_auth
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token or API key" });
  }
}

module.exports = jwtOrApiKey;
