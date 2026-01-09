const jwt = require("jsonwebtoken");

/*
Middleware: JWT or API key
- Attaches req.auth
- Issues a refreshed token
- Injects token into response body automatically
*/
function jwtOrApiKey(req, res, next) {
  try {
    // API key check
    const apiKey = req.headers["x-api-key"];
    if (apiKey && apiKey === process.env.INTERNAL_API_KEY) {
      req.auth = { type: "api_key" };
      return next();
    }

    // JWT check
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Defensive checks
    if (!payload.sub || !payload.user_auth || !payload.user_auth.startsWith("authorized")) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Attach auth context
    req.auth = {
      type: "jwt",
      userId: payload.sub,
      username: payload.username,
      user_type: payload.user_type,
      user_auth: payload.user_auth
    };

    // ---------- Sliding refresh ----------
    const refreshedToken = jwt.sign(
      {
        sub: payload.sub,
        username: payload.username,
        user_type: payload.user_type,
        user_auth: payload.user_auth
      },
      process.env.JWT_SECRET,
     { expiresIn: "7d" }
     // { expiresIn: "1h" }
     // { expiresIn: "1m" }
    );

    // Save refreshed token in res.locals
    res.locals.newToken = refreshedToken;

    // Wrap res.json to automatically include token
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Only attach token if body is an object
      if (body && typeof body === "object" && !Array.isArray(body)) {
        body.token = refreshedToken;
      }
      return originalJson(body);
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token or API key" });
  }
}

module.exports = jwtOrApiKey;
