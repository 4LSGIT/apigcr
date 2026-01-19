const express = require("express");
const router = express.Router();
const db = require("../startup/db");

// Helpers
const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() ||
  req.socket?.remoteAddress;

const logAttempt = async (
  username,
  password,
  ip,
  userAgent,
  queries,
  authStatus
) => {
  const logQuery = `
    INSERT INTO query_log (username, password, ip_address, user_agent, query, auth_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const logParams = [
    username,
    password,
    ip,
    userAgent,
    queries.join(" ||| "),
    authStatus,
  ];

  try {
    await db.query(logQuery, logParams);
  } catch (err) {
    console.error("Error logging query attempt:", err.message);
  }
};

// Base64 decode helper with validation
const decodeBase64 = (value) => {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");

    // Reject empty or obviously bad decodes
    if (!decoded || decoded.trim().length === 0) {
      throw new Error("Decoded query is empty");
    }

    return decoded;
  } catch {
    return null;
  }
};

// Main route
router.get("/db64", async (req, res) => {
  const { username, password, query } = req.query;

  if (!username || !password || !query) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // Decode Base64 query
  const decodedQuery = decodeBase64(query);
  if (!decodedQuery) {
    return res.status(400).json({ error: "Invalid base64 query parameter" });
  }

  // Split queries safely
  let queries = decodedQuery.endsWith("|||")
    ? decodedQuery.slice(0, -3)
    : decodedQuery;

  queries = queries.split("|||");

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // Authorization check
    const [authResult] = await db.query(
      "SELECT user_auth FROM users WHERE username = ? AND password = ?",
      [username, password]
    );

    const isAuthorized =
      authResult.length > 0 &&
      authResult[0].user_auth.startsWith("authorized");

    // Always log attempt
    await logAttempt(
      username,
      password,
      ip,
      userAgent,
      queries,
      isAuthorized ? "authorized" : "unauthorized"
    );

    if (!isAuthorized) {
      return res.status(401).json({ error: "Unauthorized access" });
    }

    // Execute all queries in parallel
    const queryPromises = queries.map(async (q) => {
      const trimmed = q.trim();
      if (!trimmed) return { error: "Empty query" };

      try {
        const [rows] = await db.query(trimmed);

        // Convert JSON strings to objects if needed
        if (Array.isArray(rows)) {
          rows.forEach((r) => {
            if (r.contacts && typeof r.contacts === "string") {
              try {
                r.contacts = JSON.parse(r.contacts);
              } catch {
                r.contacts = [];
              }
            }
          });
        }

        return rows;
      } catch (err) {
        return { error: err.message };
      }
    });

    const results = await Promise.all(queryPromises);

    const queryResults = {};
    results.forEach((r, i) => {
      queryResults[`query${i + 1}`] = r;
    });

    return res.json({ data: queryResults });
  } catch (err) {
    console.error("DB error:", err.message);
    return res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
