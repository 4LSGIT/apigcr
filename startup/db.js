// startup/db.js

const mysql = require("mysql2");

const pool = mysql.createPool({
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database,
  timezone: "Z"
});

pool.on("error", err => {
  console.error("MySQL pool error:", err);
});

module.exports = pool.promise();
