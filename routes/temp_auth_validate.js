// routes/auth.validate.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

router.post("/auth/P_validate", async (req, res) => {
  const { username, password, token } = req.body;

  try {
    // --- JWT path ---
    if (token) {
      let payload;
      try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
      } catch (err) {
        return res.status(401).json({ valid: false, error: "Invalid token" });
      }

      if (!payload.sub || !payload.user_auth?.startsWith("authorized")) {
        return res.status(401).json({ valid: false, error: "Unauthorized" });
      }

      // Fetch full user row so response shape is identical to the legacy query
      const [rows] = await req.db.query(
        "SELECT * FROM users WHERE user = ?",
        [payload.sub]
      );

      if (!rows.length) {
        return res.status(401).json({ valid: false, error: "User not found" });
      }

      return res.json(rows);
    }

    // --- Username/password path (legacy) ---
    if (username && password) {
      const [rows] = await req.db.query(
        "SELECT * FROM users WHERE username = ? AND password = ?",
        [username, password]
      );

      // Return same shape regardless of result — empty array means no match,
      // Pabbly already knows how to handle that from its current flow
      return res.json(rows);
    }

    return res.status(400).json({ valid: false, error: "No credentials provided" });

  } catch (err) {
    console.error("auth/validate error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;