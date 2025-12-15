const express = require("express");
const router = express.Router();

// Helper to get client IP
const getClientIp = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket?.remoteAddress
  );
};

// Helper to log attempts (can reuse from your auth example)
const logAttempt = (db, username, password, ip, userAgent, action, status) => {
  const logQuery = `
    INSERT INTO query_log (username, password, ip_address, user_agent, query, auth_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const logParams = [username, password, ip, userAgent, action, status];

  db.getConnection((err, connection) => {
    if (err) return console.error("Failed DB connection for logging");
    connection.query(logQuery, logParams, (err) => {
      if (err) console.error("Error logging attempt:", err.message);
      connection.release();
    });
  });
};

// Main endpoint
router.post("/unplacehold", async (req, res) => {
  const { username, password, text, contact_id } = req.body;
  if (!username || !password || !text || !contact_id) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  // Verify user
  const authQuery = "SELECT user_auth FROM users WHERE username = ? AND password = ?";
  const authParams = [username, password];

  req.db.getConnection((err, connection) => {
    if (err) return res.status(500).json({ error: "DB connection error" });

    connection.query(authQuery, authParams, (err, result) => {
      if (err) {
        connection.release();
        logAttempt(req.db, username, password, ip, userAgent, "auth", "unauthorized");
        return res.status(500).json({ error: "Authorization query error" });
      }

      const isAuthorized = result.length > 0 && result[0].user_auth.startsWith("authorized");
      logAttempt(req.db, username, password, ip, userAgent, "auth", isAuthorized ? "authorized" : "unauthorized");

      if (!isAuthorized) {
        connection.release();
        return res.status(401).json({ error: "Unauthorized access" });
      }

      // Fetch contact info
      const contactQuery = "SELECT * FROM contacts WHERE contact_id = ?";
      connection.query(contactQuery, [contact_id], (err, contactRows) => {
        connection.release();
        if (err) return res.status(500).json({ error: "Error fetching contact data" });
        if (!contactRows.length) return res.status(404).json({ error: "Contact not found" });

        const contact = contactRows[0];

        // Replace placeholders
        let replacedText = text.replace(/{{contact\.([a-zA-Z0-9_]+)}}/g, (match, p1) => {
          return contact[p1] !== undefined ? contact[p1] : match;
        });

        return res.json({ text: replacedText });
      });
    });
  });
});

module.exports = router;
