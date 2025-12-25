const express = require("express");
const router = express.Router();
const unplacehold = require("../lib/unplacehold");

/* ------------------ helpers ------------------ */

const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() ||
  req.socket?.remoteAddress;

const logAttempt = (db, username, password, ip, userAgent, status) => {
  const q = `
    INSERT INTO query_log
    (username, password, ip_address, user_agent, query, auth_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  db.getConnection((err, c) => {
    if (err) return;
    c.query(q, [username, password, ip, userAgent, "unplacehold", status], () =>
      c.release()
    );
  });
};

/* ------------------ route ------------------ */

router.post("/unplacehold", async (req, res) => {
  const {
    username,
    password,
    text,
    strict = false,
    contact_id,
    case_id,
    case_number,
    case_number_full,
    appt_id,
  } = req.body;

  if (!username || !password || !text) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  try {
    // --- auth ---
    const [auth] = await req.db
      .query(
        "SELECT user_auth FROM users WHERE username=? AND password=?",
        [username, password]
      );

    if (!auth.length || !auth[0].user_auth.startsWith("authorized")) {
      logAttempt(req.db, username, password, ip, userAgent, "unauthorized");
      return res.status(401).json({ error: "Unauthorized" });
    }

    logAttempt(req.db, username, password, ip, userAgent, "authorized");

    // --- delegate to shared logic ---
    const result = await unplacehold({
      db: req.db,
      text,
      contact_id,
      case_id,
      case_number,
      case_number_full,
      appt_id,
      strict
    });

    if (result.status === "failed") {
      return res.status(400).json({
        status: result.status,
        error: "Strict mode unresolved placeholders",
        unresolved: result.unresolved
      });
    }

    return res.json(result);

  } catch (err) {
    console.error("Unplacehold error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
