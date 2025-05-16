const express = require("express");
const router = express.Router();
const db = require('../startup/db');

router.get("/dbq", (req, res) => {
  //const db = req.db;//using the new way
  
  db.query("SELECT 6+5 AS result", (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Database query failed" });
    }
    res.json({ result: results[0].result }); // Send the result in response
  });
});

module.exports = router;
