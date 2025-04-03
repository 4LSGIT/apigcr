const express = require("express");
const router = express.Router();

router.get("/dbq", (req, res) => {
  const db = req.db;
  
  db.query("SELECT 6+4 AS result", (err, results) => {
    if (err) {
      console.error("Database query error:", err);
      return res.status(500).json({ error: "Database query failed" });
    }
    
    res.json({ result: results[0].result }); // Send the result in response
  });
});

module.exports = router;
