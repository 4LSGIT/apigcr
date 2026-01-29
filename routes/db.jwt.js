const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

// helpers (or import from shared util)
const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() ||
  req.socket?.remoteAddress;

const logAttempt = async (db, username, ip, userAgent, queries, authStatus, authType) => {
  const logQuery = `
    INSERT INTO query_log (username, password, ip_address, user_agent, query, auth_status, auth_type)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const logParams = [
    username,
    "",
    ip,
    userAgent,
    queries.join(" ||| "),
    authStatus,
    authType
  ];

  try {
    await db.query(logQuery, logParams);
  } catch (err) {
    console.error("Error logging JWT/API query attempt:", err.message);
  }
};

const getAuthUsername = (auth) => {
  if (!auth) return "UNKNOWN";
  if (auth.type === "jwt") {
    return auth.username || auth.sub || "JWT_UNKNOWN";
  }
  if (auth.type === "apiKey") {
    return "API_KEY";
  }
  return "UNKNOWN";
};


/*
GET /db-jwt?query=SELECT+1|||SELECT+2
Headers:
Authorization: Bearer <jwt>
(or)
x-api-key: <internal key>
*/
router.get("/db-jwt", jwtOrApiKey, async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  let queries = query.endsWith("|||") ? query.slice(0, -3) : query;
  queries = queries.split("|||");

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";
  const username = getAuthUsername(req.auth);

  try {
    const results = await Promise.all(
      queries.map(async (q) => {
        const trimmed = q.trim();
        if (!trimmed) return { error: "Empty query" };

        try {
          const [rows] = await req.db.query(trimmed);
          return rows;
        } catch (err) {
          return { error: err.message };
        }
      })
    );

    // 🔒 log only approved attempts
    await logAttempt(
      req.db,
      username,
      ip,
      userAgent,
      queries,
      "authorized",
      req.auth.type || "unknown"
    );

    const response = {};
    results.forEach((r, i) => {
      response[`query${i + 1}`] = r;
    });

    res.json({
      auth: req.auth,
      data: response
    });
  } catch (err) {
    console.error("DB-JWT error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;

/*
const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");


//GET /db-jwt?query=SELECT+1|||SELECT+2
//Headers:
//Authorization: Bearer <jwt>
//(or)
//x-api-key: <internal key>

router.get("/db-jwt", jwtOrApiKey, async (req, res) => {
  const { query } = req.query;

  if (!query) {
    return res.status(400).json({ error: "Missing query parameter" });
  }

  // Split multi-queries (same behavior as legacy route)
  let queries = query.endsWith("|||") ? query.slice(0, -3) : query;
  queries = queries.split("|||");

  try {
    const results = await Promise.all(
      queries.map(async (q) => {
        const trimmed = q.trim();
        if (!trimmed) return { error: "Empty query" };

        try {
          const [rows] = await req.db.query(trimmed);
          return rows;
        } catch (err) {
          return { error: err.message };
        }
      })
    );

    const response = {};
    results.forEach((r, i) => {
      response[`query${i + 1}`] = r;
    });

    res.json({
      auth: req.auth,   // useful for debugging / auditing
      data: response
    });
  } catch (err) {
    console.error("DB-JWT error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;*/
