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

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok || !user.user_auth.startsWith("authorized")) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Medium-lived JWT (sliding session handled by middleware)
    const token = jwt.sign(
      {
        sub: user.user,           // primary key
        username: user.username,
        user_type: user.user_type,
        user_auth: user.user_auth
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

module.exports = router;
