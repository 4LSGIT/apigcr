const express = require("express");
const router = express.Router();
const path = require("path");
const db = require('../startup/db');

// Route to handle user authentication and query processing
router.get("/db", (req, res) => {
  //const db = req.db;
  const { username, password, query } = req.query;

  const requiredParams = ["username", "password", "query"];
  const missingParams = requiredParams.filter(param => !req.query[param]);

  if (missingParams.length > 0) {
    return res.status(400).json({
      error: `Missing required parameter${missingParams.length > 1 ? "s" : ""}: ${missingParams.join(", ")}`
    });
  }
  
 let queries = query.endsWith('|||') ? query.slice(0, -3) : query;
  queries = queries.split("|||");

  // Query to check user authorization
  const authQuery = "SELECT user_auth FROM users WHERE username = ? AND password = ?";
  const authParams = [username, password];

  db.getConnection((err, connection) => {
    if (err) {
      console.error("Error getting MySQL connection: " + err.stack);
      res.status(500).json({ error: "Error getting MySQL connection" });
      return;
    }

    connection.query(authQuery, authParams, (err, result) => {
      connection.release(); // Release the connection back to the pool

      if (err) {
        console.log(err);
        res.status(500).json({ error: "Error executing authorization query" });
      } else {
        if (result.length > 0 && result[0].user_auth.startsWith("authorized")) {
          // User is authorized, proceed with the main query
          db.getConnection((err, connection) => {
            if (err) {
              console.error("Error getting MySQL connection: " + err.stack);
              res.status(500).json({ error: "Error getting MySQL connection" });
              return;
            }

            let queryResults = {}; // Object to store the results of all queries

            // Execute each query in the order provided
            queries.forEach((query, index) => {
              if (query.trim() !== "") {
                connection.query(query, (err, result) => {
                  if (err) {
                    queryResults[`query${index + 1}`] = { error: err.message }; // Store the error message
                  } else {
                    queryResults[`query${index + 1}`] = result; // Store the query result
                  }

                  // Check if all queries have been executed
                  if (Object.keys(queryResults).length === queries.length) {
                    res.json({ data: queryResults }); // Return the results object
                  }
                });
              } else {
                queryResults[`query${index + 1}`] = { error: "Empty query" }; // Store the empty query error
              }
            });

            connection.release(); // Release the connection back to the pool
          });
        } else {
          res.status(401).json({ error: "Unauthorized access" });
        }
      }
    });
  });
});

module.exports = router;
