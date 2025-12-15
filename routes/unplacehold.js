const express = require("express");
const router = express.Router();

// Helper: client IP
const getClientIp = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket?.remoteAddress
  );
};

// Helper: log attempts
const logAttempt = (db, username, password, ip, userAgent, action, status) => {
  const logQuery = `
    INSERT INTO query_log
    (username, password, ip_address, user_agent, query, auth_status)
    VALUES (?, ?, ?, ?, ?, ?)
  `;
  const logParams = [username, password, ip, userAgent, action, status];

  db.getConnection((err, conn) => {
    if (err) return;
    conn.query(logQuery, logParams, () => conn.release());
  });
};

router.post("/unplacehold", (req, res) => {
  const {
    username,
    password,
    text,

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

  // ---- AUTH ----
  const authQuery =
    "SELECT user_auth FROM users WHERE username = ? AND password = ?";

  req.db.getConnection((err, conn) => {
    if (err) return res.status(500).json({ error: "DB connection error" });

    conn.query(authQuery, [username, password], (err, authRows) => {
      if (err) {
        conn.release();
        logAttempt(req.db, username, password, ip, userAgent, "unplacehold", "unauthorized");
        return res.status(500).json({ error: "Authorization error" });
      }

      const authorized =
        authRows.length > 0 &&
        authRows[0].user_auth.startsWith("authorized");

      logAttempt(
        req.db,
        username,
        password,
        ip,
        userAgent,
        "unplacehold",
        authorized ? "authorized" : "unauthorized"
      );

      if (!authorized) {
        conn.release();
        return res.status(401).json({ error: "Unauthorized" });
      }

      // ---- DATA FETCH ----
      let contact = null;
      let caseData = null;
      let appt = null;

      const tasks = [];

      // CONTACT
      if (contact_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM contacts WHERE contact_id = ?",
              [contact_id],
              (err, rows) => {
                if (!err && rows.length) contact = rows[0];
                resolve();
              }
            );
          })
        );
      }

      // CASE (priority order)
      if (case_id || case_number || case_number_full) {
        let caseQuery = "";
        let caseParam = null;

        if (case_id) {
          caseQuery = "SELECT * FROM cases WHERE case_id = ?";
          caseParam = case_id;
        } else if (case_number_full) {
          caseQuery = "SELECT * FROM cases WHERE case_number_full = ?";
          caseParam = case_number_full;
        } else if (case_number) {
          caseQuery = "SELECT * FROM cases WHERE case_number = ?";
          caseParam = case_number;
        }

        tasks.push(
          new Promise((resolve) => {
            conn.query(caseQuery, [caseParam], (err, rows) => {
              if (!err && rows.length) caseData = rows[0];
              resolve();
            });
          })
        );
      }

      // APPOINTMENT
      if (appt_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM appts WHERE appt_id = ?",
              [appt_id],
              (err, rows) => {
                if (!err && rows.length) appt = rows[0];
                resolve();
              }
            );
          })
        );
      }

      Promise.all(tasks).then(() => {
        conn.release();

        let output = text;

        // CONTACT placeholders
        if (contact) {
          output = output.replace(
            /{{contact\.([a-zA-Z0-9_]+)}}/g,
            (_, field) =>
              contact[field] !== undefined ? contact[field] : _
          );
        }

        // CASE placeholders
        if (caseData) {
          output = output.replace(
            /{{case\.([a-zA-Z0-9_]+)}}/g,
            (_, field) =>
              caseData[field] !== undefined ? caseData[field] : _
          );
        }

        // APPT placeholders
        if (appt) {
          output = output.replace(
            /{{appt\.([a-zA-Z0-9_]+)}}/g,
            (_, field) =>
              appt[field] !== undefined ? appt[field] : _
          );
        }

        return res.json({
          text: output,
          resolved: {
            contact: !!contact,
            case: !!caseData,
            appt: !!appt,
          },
        });
      });
    });
  });
});

module.exports = router;
