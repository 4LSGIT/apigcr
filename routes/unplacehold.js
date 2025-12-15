const express = require("express");
const router = express.Router();

/* ------------------ helpers ------------------ */

const getClientIp = (req) =>
  req.headers["x-forwarded-for"]?.split(",").shift() ||
  req.socket?.remoteAddress;

// zero-pad helper
const pad = (n) => (n < 10 ? "0" + n : n);

// SAFE date/time formatter (no external libs)
const formatDate = (value, format) => {
  const d = new Date(value);
  if (isNaN(d)) return null;

  const tokens = {
    YYYY: d.getFullYear(),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    hh: pad(d.getHours() % 12 || 12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() >= 12 ? "PM" : "AM",
  };

  let output = format;
  Object.keys(tokens).forEach((t) => {
    output = output.replace(t, tokens[t]);
  });

  return output;
};

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

router.post("/unplacehold", (req, res) => {
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

  const authQuery =
    "SELECT user_auth FROM users WHERE username = ? AND password = ?";

  req.db.getConnection((err, conn) => {
    if (err) return res.status(500).json({ error: "DB connection error" });

    conn.query(authQuery, [username, password], (err, auth) => {
      if (err || !auth.length || !auth[0].user_auth.startsWith("authorized")) {
        conn.release();
        logAttempt(req.db, username, password, ip, userAgent, "unauthorized");
        return res.status(401).json({ error: "Unauthorized" });
      }

      logAttempt(req.db, username, password, ip, userAgent, "authorized");

      let contact = null;
      let caseData = null;
      let appt = null;
      const tasks = [];

      if (contact_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM contacts WHERE contact_id = ?",
              [contact_id],
              (_, r) => {
                if (r?.length) contact = r[0];
                resolve();
              }
            );
          })
        );
      }

      if (case_id || case_number || case_number_full) {
        let q, p;
        if (case_id) {
          q = "SELECT * FROM cases WHERE case_id = ?";
          p = case_id;
        } else if (case_number_full) {
          q = "SELECT * FROM cases WHERE case_number_full = ?";
          p = case_number_full;
        } else {
          q = "SELECT * FROM cases WHERE case_number = ?";
          p = case_number;
        }

        tasks.push(
          new Promise((resolve) => {
            conn.query(q, [p], (_, r) => {
              if (r?.length) caseData = r[0];
              resolve();
            });
          })
        );
      }

      if (appt_id) {
        tasks.push(
          new Promise((resolve) => {
            conn.query(
              "SELECT * FROM appts WHERE appt_id = ?",
              [appt_id],
              (_, r) => {
                if (r?.length) appt = r[0];
                resolve();
              }
            );
          })
        );
      }

      Promise.all(tasks).then(() => {
        conn.release();

        const unresolved = [];
        let output = text;

        const resolveEntity = (entityName, entity) => {
          const regex =
            /{{(\w+)\.(\w+)(?:\|([^}]+))?}}/g;

          output = output.replace(regex, (match, e, field, pipe) => {
            if (e !== entityName) return match;

            let value = entity?.[field];

            let format = null;
            let def = null;

            if (pipe) {
              pipe.split("|").forEach((part) => {
                if (part.startsWith("date:") || part.startsWith("time:") || part.startsWith("datetime:")) {
                  format = part.split(":")[1];
                } else if (part.startsWith("default:")) {
                  def = part.slice(8);
                }
              });
            }

            if (value === undefined || value === null) {
              if (def !== null) return def;
              unresolved.push(match);
              return match;
            }

            if (format) {
              const formatted = formatDate(value, format);
              if (formatted === null) {
                if (def !== null) return def;
                unresolved.push(match);
                return match;
              }
              return formatted;
            }

            return value;
          });
        };

        resolveEntity("contact", contact);
        resolveEntity("case", caseData);
        resolveEntity("appt", appt);

        let status = "success";
        if (unresolved.length && strict) status = "failed";
        else if (unresolved.length) status = "partial_success";

        if (status === "failed") {
          return res.status(400).json({
            status,
            error: "Strict mode unresolved placeholders",
            unresolved,
          });
        }

        return res.json({
          status,
          text: output,
          unresolved,
        });
      });
    });
  });
});

module.exports = router;
