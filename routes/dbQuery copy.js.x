const express = require("express");
const router = express.Router();
const db = require("../startup/db");

// Get client IP address
const getClientIp = (req) => {
  return (
    req.headers["x-forwarded-for"]?.split(",").shift() ||
    req.socket?.remoteAddress
  );
};

// Log request attempt
const logAttempt = (username, password, ip, userAgent, queries, authStatus) => {
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

  db.getConnection((err, logConnection) => {
    if (err) {
      console.error("Failed to get DB connection for logging");
      return;
    }

    logConnection.query(logQuery, logParams, (logErr) => {
      if (logErr) {
        console.error("Error logging query attempt:", logErr.message);
      }
      logConnection.release();
    });
  });
};

// Main route
router.get("/db", (req, res) => {
  const { username, password, query } = req.query;

  const requiredParams = ["username", "password", "query"];
  const missingParams = requiredParams.filter((param) => !req.query[param]);

  if (missingParams.length > 0) {
    return res.status(400).json({
      error: `Missing required parameter${
        missingParams.length > 1 ? "s" : ""
      }: ${missingParams.join(", ")}`,
    });
  }

  let queries = query.endsWith("|||") ? query.slice(0, -3) : query;
  queries = queries.split("|||");

  const ip = getClientIp(req);
  const userAgent = req.headers["user-agent"] || "unknown";

  const authQuery =
    "SELECT user_auth FROM users WHERE username = ? AND password = ?";
  const authParams = [username, password];

  db.getConnection((err, connection) => {
    if (err) {
      console.error("Error getting MySQL connection:", err.stack);
      res.status(500).json({ error: "Error getting MySQL connection" });
      return;
    }

    connection.query(authQuery, authParams, (err, result) => {
      connection.release();

      if (err) {
        console.error("Error executing authorization query:", err.message);
        logAttempt(username, password, ip, userAgent, queries, "unauthorized");
        return res.status(500).json({ error: "Authorization query error" });
      }

      const isAuthorized =
        result.length > 0 && result[0].user_auth.startsWith("authorized");

      // Log attempt (always)
      logAttempt(
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

      // Proceed to execute queries
      db.getConnection((err, connection) => {
        if (err) {
          console.error("Error getting MySQL connection:", err.stack);
          return res
            .status(500)
            .json({ error: "Error getting MySQL connection" });
        }

        let queryResults = {};

        queries.forEach((q, index) => {
          if (q.trim() !== "") {
            connection.query(q, (err, result) => {
              if (err) {
                queryResults[`query${index + 1}`] = { error: err.message };
              } else {
                queryResults[`query${index + 1}`] = result;
              }

              if (Object.keys(queryResults).length === queries.length) {
                connection.release();
                return res.json({ data: queryResults });
              }
            });
          } else {
            queryResults[`query${index + 1}`] = { error: "Empty query" };

            if (Object.keys(queryResults).length === queries.length) {
              connection.release();
              return res.json({ data: queryResults });
            }
          }
        });
      });
    });
  });
});

module.exports = router;
