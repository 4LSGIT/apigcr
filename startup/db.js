// db.js

const mysql = require("mysql");

const db = mysql.createPool({
  connectionLimit: 10,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});

// Optional: centralised error listener
db.on("error", err => {
  console.error("MySQL error:", err);
});

module.exports = db;   // ← exports ONE shared object