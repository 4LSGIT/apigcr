const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const router = express.Router();

/*
POST /login
Body: { username, password }

Returns:
{ token }
*/
router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Missing credentials" });
  }

  try {
    // Fetch user by username
    const [rows] = await req.db.query(
      `
      SELECT user, username, user_type, user_auth, password_hash
      FROM users
      WHERE username = ?
      `,
      [username]
    );

    if (!rows.length) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = rows[0];

    if (!user.password_hash) {
      return res.status(403).json({ error: "Account not enabled for login" });
    }

    // Check password
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok || !user.user_auth.startsWith("authorized")) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Issue 24-hour JWT
    const token = jwt.sign(
      {
        sub: user.user,           // primary key
        username: user.username,
        user_type: user.user_type,
        user_auth: user.user_auth,
        ver: parseInt(process.env.JWT_VERSION || 1) // optional global logout
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
