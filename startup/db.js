// startup/db.js

const mysql = require("mysql2");

const pool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  timezone: 'Z'
});

// Optional: centralised error listener
pool.on("error", err => {
  console.error("MySQL error:", err);
});

module.exports = pool.promise();
