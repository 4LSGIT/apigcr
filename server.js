const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
var corsOptions = { origin: "*" };
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, path, stat) => {
      if (path.endsWith(".js")) {
        res.set("Content-Type", "application/javascript");
      } else if (path.endsWith(".css")) {
        res.set("Content-Type", "text/css");
      }
    },
  })
);

const db = require("./startup/db");//and we are going to attach it to each route
/*
reference to startup/db.js:
const mysql = require("mysql2");
const pool = mysql.createPool({
  connectionLimit: 10,
  host: process.env.host,
  user: process.env.user,
  password: process.env.password,
  database: process.env.database
});
pool.on("error", err => {
  console.error("MySQL error:", err);
});
module.exports = pool.promise();
*/

const routesPath = path.join(__dirname, "routes");

app.get("/:page", (req, res, next) => {
  const filePath = path.join(__dirname, "public", req.params.page + ".html");
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  next(); // continue to normal routes if file doesn’t exist
});

fs.readdirSync(routesPath).forEach((file) => {
  if (file.endsWith(".js")) {
    const route = require(`./routes/${file}`);
    app.use((req, res, next) => {
      req.db = db; // Attach db to request object
      next();
    }, route);
  }
});

require("./startup/init")(db);

// Set port and start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}.`);
  if (process.env.ENVIRONMENT == "development") {
    console.log(`visit http://localhost:${PORT}/`);
  }
});
