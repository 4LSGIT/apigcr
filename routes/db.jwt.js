const express = require("express");
const router = express.Router();
const jwtOrApiKey = require("../lib/auth.jwtOrApiKey");

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

module.exports = router;
